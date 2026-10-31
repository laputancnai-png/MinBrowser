import { attempt, call, h, shell, toast } from '../_shared/min';

interface Credential {
  id: number;
  origin: string;
  username: string;
  updated_at: number;
  last_used_at: number | null;
}

const main = shell('passwords', '密码');
const search = h('input', { type: 'search', class: 'search', placeholder: '搜索网站或用户名' });
const list = h('div');
const neverBox = h('div');

const origin = h('input', { type: 'text', placeholder: '网址，例如 example.com' });
const username = h('input', { type: 'text', placeholder: '用户名' });
const password = h('input', { type: 'text', placeholder: '密码', class: 'mono' });

main.append(
  h('h1', { text: '密码' }),
  h('p', { class: 'subtitle' }, '每条密码都单独加密。复制的密码会在 30 秒后从剪贴板清除。'),
  h('div', { class: 'toolbar' }, search),
  list,
  h('h2', { text: '手动添加' }),
  h('div', { class: 'card' },
    h('div', { class: 'form-grid', style: 'grid-template-columns:1.2fr 1fr 1.2fr auto auto' },
      origin, username, password,
      h('button', { text: '生成', title: '生成强密码', on: { click: async () => (password.value = await call<string>('passwords.generate')) } }),
      h('button', { class: 'primary', text: '保存', on: { click: add } }))),
  neverBox,
);

let creds: Credential[] = [];

async function load(): Promise<void> {
  creds = await call<Credential[]>('passwords.list');
  render();
  const never = await call<string[]>('passwords.neverList');
  neverBox.replaceChildren(
    ...(never.length
      ? [
          h('h2', { text: '永不保存的网站' }),
          h('div', { class: 'card' }, ...never.map((o) =>
            h('div', { class: 'row' }, h('div', { class: 'main' }, h('span', { class: 'title', text: o })),
              h('button', { class: 'small', text: '移除', on: { click: async () => { await call('passwords.unsetNever', o); load(); } } })))),
        ]
      : []),
  );
}

function render(): void {
  const q = search.value.trim().toLowerCase();
  const shown = creds.filter((c) => !q || c.origin.toLowerCase().includes(q) || c.username.toLowerCase().includes(q));
  list.replaceChildren(
    h('div', { class: 'card' }, ...(shown.length ? shown.map(row) : [h('div', { class: 'empty', text: creds.length ? '没有匹配的密码' : '还没有保存的密码。登录网站时会提示你保存。' })])),
  );
}

function row(c: Credential): HTMLElement {
  const secret = h('span', { class: 'meta mono', text: '••••••••••' });
  let shownPw: string | null = null;
  const reveal = h('button', {
    class: 'small',
    text: '显示',
    on: {
      click: async () => {
        if (shownPw === null) {
          shownPw = (await attempt(() => call<string>('passwords.reveal', c.id))) ?? null;
          if (shownPw === null) return;
          secret.textContent = shownPw;
          reveal.textContent = '隐藏';
        } else {
          shownPw = null;
          secret.textContent = '••••••••••';
          reveal.textContent = '显示';
        }
      },
    },
  });
  const el = h('div', { class: 'row' },
    h('div', { class: 'main' }, h('span', { class: 'title', text: c.origin.replace(/^https:\/\//, '') }), h('span', { class: 'sub', text: c.username || '（无用户名）' })),
    secret,
    h('div', { class: 'actions' },
      reveal,
      h('button', { class: 'small', text: '复制', on: { click: async () => { await attempt(() => call('passwords.copy', c.id)); toast('已复制，30 秒后自动清除'); } } }),
      h('button', { class: 'small', text: '编辑', on: { click: () => edit(el, c) } }),
      h('button', { class: 'small danger', text: '删除', on: { click: async () => {
        if (!confirm(`删除 ${c.origin} 的密码（${c.username || '无用户名'}）？`)) return;
        await call('passwords.remove', c.id);
        load();
      } } })));
  return el;
}

async function edit(el: HTMLElement, c: Credential): Promise<void> {
  const current = await attempt(() => call<string>('passwords.reveal', c.id));
  if (current === undefined) return;
  const user = h('input', { type: 'text', value: c.username, style: 'flex:1' });
  const pw = h('input', { type: 'text', value: current, class: 'mono', style: 'flex:1' });
  const save = async () => {
    await attempt(() => call('passwords.update', c.id, { username: user.value, password: pw.value }));
    load();
  };
  el.replaceChildren(h('span', { class: 'meta', text: c.origin }), user, pw,
    h('button', { class: 'small primary', text: '保存', on: { click: save } }),
    h('button', { class: 'small', text: '取消', on: { click: render } }));
}

async function add(): Promise<void> {
  const id = await attempt(() => call('passwords.add', origin.value, username.value, password.value));
  if (id === undefined) return;
  origin.value = username.value = password.value = '';
  toast('已保存');
  load();
}

search.addEventListener('input', render);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) load();
});
attempt(load);
