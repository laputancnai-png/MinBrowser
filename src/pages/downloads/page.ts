import { attempt, call, fmtBytes, h, hostOf, shell } from '../_shared/min';

interface Download {
  id: number;
  filename: string;
  path: string;
  url: string;
  state: 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted';
  received: number;
  total: number;
}

const STATE: Record<Download['state'], string> = {
  progressing: '下载中',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
  interrupted: '失败',
};

const main = shell('downloads', '下载');
const list = h('div');
main.append(
  h('h1', { text: '下载' }),
  h('p', { class: 'subtitle' }, '下载列表只在这次运行期间保留，不会写入磁盘。'),
  h('div', { class: 'toolbar' }, h('span', { class: 'grow' }), h('button', { text: '清除已完成', on: { click: async () => { await call('downloads.clear'); load(); } } })),
  list,
);

const act = (method: string, id: number) => async () => {
  await attempt(() => call(method, id));
  load();
};

function row(d: Download): HTMLElement {
  const pct = d.total > 0 ? Math.min(100, (d.received / d.total) * 100) : 0;
  const active = d.state === 'progressing' || d.state === 'paused';
  const size = active ? `${fmtBytes(d.received)} / ${d.total ? fmtBytes(d.total) : '未知'}` : fmtBytes(d.total || d.received);
  const actions: HTMLElement[] = [];
  if (d.state === 'progressing') actions.push(h('button', { class: 'small', text: '暂停', on: { click: act('downloads.pause', d.id) } }));
  if (d.state === 'paused') actions.push(h('button', { class: 'small', text: '继续', on: { click: act('downloads.resume', d.id) } }));
  if (active) actions.push(h('button', { class: 'small danger', text: '取消', on: { click: act('downloads.cancel', d.id) } }));
  if (d.state === 'completed') {
    actions.push(
      h('button', { class: 'small', text: '打开', on: { click: act('downloads.open', d.id) } }),
      h('button', { class: 'small', text: '在文件夹中显示', on: { click: act('downloads.show', d.id) } }),
    );
  }
  return h('div', { class: 'row' },
    h('div', { class: 'main' },
      h('span', { class: 'title', text: d.filename, title: d.path }),
      h('span', { class: 'sub', text: `${STATE[d.state]} · ${size} · ${hostOf(d.url)}` }),
      active ? h('div', { class: 'progress' }, h('div', { style: `width:${pct}%` })) : null),
    h('div', { class: 'actions', style: 'opacity:1' }, ...actions));
}

async function load(): Promise<void> {
  const items = await call<Download[]>('downloads.list');
  list.replaceChildren(h('div', { class: 'card' }, ...(items.length ? items.map(row) : [h('div', { class: 'empty', text: '还没有下载' })])));
}

attempt(load);
setInterval(() => {
  if (!document.hidden) load().catch(() => undefined);
}, 1000);
