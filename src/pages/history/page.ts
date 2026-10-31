import { attempt, call, fmtDay, fmtDuration, fmtTime, h, hostOf, shell, toast, wantsNewTab } from '../_shared/min';

interface Visit {
  id: number;
  url: string;
  title: string;
  visited_at: number;
  duration_ms: number;
}

const PAGE = 150;
const main = shell('history', '历史记录');

const status = h('span', { class: 'chip' });
const toggle = h('button', { class: 'small' });
const search = h('input', { type: 'search', class: 'search', placeholder: '搜索标题或网址（支持中文）' });
const range = h(
  'select',
  {},
  h('option', { value: '', text: '删除记录…' }),
  h('option', { value: String(3600e3), text: '最近一小时' }),
  h('option', { value: String(86400e3), text: '最近 24 小时' }),
  h('option', { value: String(7 * 86400e3), text: '最近 7 天' }),
  h('option', { value: 'all', text: '全部记录' }),
);
const list = h('div');
const more = h('button', { text: '加载更多', hidden: true });

main.append(
  h('h1', { text: '历史记录' }),
  h('p', { class: 'subtitle' }, '加密保存在你的数据文件夹里。网址中的追踪参数和登录凭证不会被记录。'),
  h('div', { class: 'toolbar' }, status, toggle, h('span', { class: 'grow' }),
    h('button', { text: '导出 CSV', on: { click: () => exportAs('csv') } }),
    h('button', { text: '导出 JSON', on: { click: () => exportAs('json') } }),
    range),
  h('div', { class: 'toolbar' }, search),
  list,
  h('div', { class: 'toolbar', style: 'justify-content:center;margin-top:16px' }, more),
);

let visits: Visit[] = [];

async function refreshStatus(): Promise<void> {
  const { paused } = await call<{ paused: boolean }>('history.status');
  status.className = paused ? 'chip warn' : 'chip';
  status.textContent = paused ? '⏸ 已暂停记录' : '● 正在记录';
  toggle.textContent = paused ? '恢复记录' : '暂停记录';
  toggle.onclick = async () => {
    await call('history.setPaused', !paused);
    refreshStatus();
  };
}

async function load(append = false): Promise<void> {
  const before = append && visits.length ? visits[visits.length - 1].visited_at : undefined;
  const batch = await call<Visit[]>('history.search', { query: search.value || undefined, before, limit: PAGE });
  visits = append ? visits.concat(batch) : batch;
  more.hidden = batch.length < PAGE;
  render();
}

function render(): void {
  if (visits.length === 0) {
    list.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'empty', text: search.value ? '没有找到匹配的记录' : '还没有浏览记录' })));
    return;
  }
  const groups = new Map<string, Visit[]>();
  for (const v of visits) {
    const day = fmtDay(v.visited_at);
    groups.set(day, [...(groups.get(day) ?? []), v]);
  }
  list.replaceChildren(
    ...[...groups].flatMap(([day, items]) => [
      h('div', { class: 'group-title', text: day }),
      h('div', { class: 'card' }, ...items.map(row)),
    ]),
  );
}

function row(v: Visit): HTMLElement {
  const open = (e: Event) => {
    e.preventDefault();
    call('history.open', v.url, wantsNewTab(e as MouseEvent));
  };
  return h(
    'div',
    { class: 'row' },
    h('span', { class: 'meta', text: fmtTime(v.visited_at) }),
    h(
      'div',
      { class: 'main' },
      h('a', { class: 'title', href: v.url, text: v.title || v.url, title: v.url, on: { click: open, auxclick: open } }),
      h('span', { class: 'sub', text: hostOf(v.url) }),
    ),
    h('span', { class: 'meta', text: fmtDuration(v.duration_ms), title: '停留时长' }),
    h(
      'div',
      { class: 'actions' },
      h('button', {
        class: 'small danger',
        text: '删除',
        on: {
          click: async () => {
            await call('history.delete', [v.id]);
            visits = visits.filter((x) => x.id !== v.id);
            render();
          },
        },
      }),
    ),
  );
}

async function exportAs(format: 'csv' | 'json'): Promise<void> {
  const ok = confirm('导出的文件不加密，任何能打开这个文件的人都能看到你的浏览记录。继续导出吗？');
  if (!ok) return;
  const res = await attempt(() => call<{ path: string; count: number } | null>('history.export', format));
  if (res) toast(`已导出 ${res.count} 条记录到 ${res.path}`);
}

range.addEventListener('change', async () => {
  const value = range.value;
  range.value = '';
  if (!value) return;
  const label = range.querySelector(`option[value="${value}"]`)?.textContent ?? '';
  if (!confirm(`确定删除“${label}”的浏览记录吗？此操作无法撤销。`)) return;
  const since = value === 'all' ? 0 : Date.now() - Number(value);
  const n = await call<number>('history.deleteSince', since);
  toast(`已删除 ${n} 条记录`);
  load();
});

let timer: number | undefined;
search.addEventListener('input', () => {
  clearTimeout(timer);
  timer = window.setTimeout(() => load(), 200);
});
more.addEventListener('click', () => load(true));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    refreshStatus();
    load();
  }
});

attempt(async () => {
  await refreshStatus();
  await load();
});
search.focus();
