import { attempt, call, h, shell, toast } from '../_shared/min';

interface Settings {
  config: {
    recordingPaused: boolean;
    autoLockMinutes: number;
    downloadDir: string | null;
    askDownloadLocation: boolean;
    clearCookiesOnExit: boolean;
    adblockEnabled: boolean;
    adblockUpdatedAt: number | null;
    showBookmarksBar: boolean;
    autofillPasswords: boolean;
  };
  dataDir: string;
  version: string;
  adblock: { updating: boolean; error: string | null; builtin: boolean };
  allowList: string[];
}

const main = shell('settings', '设置');

const setting = (label: string, hint: string | null, control: HTMLElement) =>
  h('div', { class: 'setting' }, h('div', { class: 'label' }, label, hint ? h('small', { text: hint }) : null), control);

const toggle = (checked: boolean, key: string) =>
  h('input', {
    type: 'checkbox',
    class: 'switch',
    checked,
    on: { change: async (e) => { await attempt(() => call('settings.set', { [key]: (e.target as HTMLInputElement).checked })); load(); } },
  });

async function load(): Promise<void> {
  const s = await call<Settings>('settings.get');
  const c = s.config;

  const lockSelect = h('select', {}, ...[[5, '5 分钟'], [15, '15 分钟'], [30, '30 分钟'], [60, '1 小时'], [0, '从不']].map(([v, t]) =>
    h('option', { value: String(v), text: String(t), selected: v === c.autoLockMinutes })));
  lockSelect.addEventListener('change', () => attempt(() => call('settings.set', { autoLockMinutes: Number(lockSelect.value) })));

  const cur = h('input', { type: 'password', placeholder: '当前主密码', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', placeholder: '新主密码（至少 8 个字符）', autocomplete: 'new-password' });
  const next2 = h('input', { type: 'password', placeholder: '再次输入新主密码', autocomplete: 'new-password' });
  const change = h('button', { class: 'primary', text: '修改主密码' });
  change.addEventListener('click', async () => {
    if (next.value !== next2.value) return toast('两次输入的新主密码不一致');
    if (!confirm('修改后请务必记住新主密码，忘记将无法恢复任何数据。确定修改吗？')) return;
    change.disabled = true;
    const ok = await attempt(() => call('settings.changePassword', cur.value, next.value));
    change.disabled = false;
    if (ok !== undefined) {
      cur.value = next.value = next2.value = '';
      toast('主密码已修改');
    }
  });

  const updated = c.adblockUpdatedAt ? new Date(c.adblockUpdatedAt).toLocaleString('zh-CN') : '从未';
  const adStatus = s.adblock.updating
    ? '正在下载规则…'
    : s.adblock.builtin
      ? `正在使用内置的基础规则。${s.adblock.error ? `下载完整规则失败：${s.adblock.error}` : ''}`
      : `EasyList + EasyPrivacy · 更新于 ${updated}${s.adblock.error ? ` · 上次更新失败：${s.adblock.error}` : ''}`;

  main.replaceChildren(
    h('h1', { text: '设置' }),
    h('p', { class: 'subtitle' }, `MinBrowser ${s.version}`),

    h('h2', { text: '数据与安全' }),
    h('div', { class: 'card' },
      setting('数据文件夹', '浏览记录、收藏夹和密码都加密保存在这里', h('code', { text: s.dataDir })),
      setting('自动锁定', '电脑闲置这么久后锁定，需要重新输入主密码', lockSelect),
      setting('立即锁定', null, h('button', { text: '锁定', on: { click: () => call('settings.lock') } })),
      h('div', { class: 'setting', style: 'display:block' },
        h('div', { class: 'label' }, '修改主密码', h('small', { text: '数据不需要重新加密，修改很快。' })),
        h('div', { class: 'form-grid', style: 'padding:12px 0 0' }, cur, next, next2, change))),

    h('h2', { text: '隐私' }),
    h('div', { class: 'card' },
      setting('暂停记录浏览历史', '暂停期间不写入任何浏览记录', toggle(c.recordingPaused, 'recordingPaused')),
      setting('自动填充密码', '打开登录页时自动填入已保存的账号（仅 https 网站）。关闭后需点击地址栏旁的钥匙按钮填入。', toggle(c.autofillPasswords, 'autofillPasswords')),
      setting('退出时清除 Cookie 和网站数据', '最私密，但每次都需要重新登录网站。缓存总是在退出时清除。', toggle(c.clearCookiesOnExit, 'clearCookiesOnExit')),
      setting('清除 Cookie 和网站数据', '立即退出所有网站的登录', h('button', { class: 'danger', text: '立即清除', on: { click: async () => {
        if (!confirm('清除所有 Cookie 和网站数据？你会退出所有网站的登录。')) return;
        await attempt(() => call('settings.clearSiteData'));
        toast('已清除');
      } } }))),

    h('h2', { text: '广告和追踪拦截' }),
    h('div', { class: 'card' },
      setting('启用拦截', adStatus, toggle(c.adblockEnabled, 'adblockEnabled')),
      setting('更新拦截规则', '从 easylist.to 下载最新规则（每 7 天自动更新）', h('button', { text: '立即更新', disabled: s.adblock.updating, on: { click: async () => {
        toast('正在下载规则…');
        await attempt(() => call('settings.updateAdblock'));
        load();
      } } })),
      ...s.allowList.map((site) => setting(site, '已在这个网站停用拦截', h('button', { class: 'small', text: '重新启用', on: { click: async () => { await call('settings.removeAllow', site); load(); } } })))),

    h('h2', { text: '下载' }),
    h('div', { class: 'card' },
      setting('下载位置', c.downloadDir ?? '系统的“下载”文件夹', h('div', { class: 'toolbar', style: 'margin:0' },
        h('button', { text: '更改…', on: { click: async () => { await attempt(() => call('settings.chooseDownloadDir')); load(); } } }),
        c.downloadDir ? h('button', { text: '恢复默认', on: { click: async () => { await call('settings.set', { downloadDir: null }); load(); } } }) : null)),
      setting('每次下载前询问保存位置', null, toggle(c.askDownloadLocation, 'askDownloadLocation'))),

    h('h2', { text: '外观' }),
    h('div', { class: 'card' },
      setting('显示收藏夹栏', null, toggle(c.showBookmarksBar, 'showBookmarksBar')),
      setting('深色模式', '跟随系统设置', h('span', { class: 'note', text: '自动' }))),
  );
}

attempt(load);
