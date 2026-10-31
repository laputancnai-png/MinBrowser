import { attempt, call, h, hostOf, shell, toast, wantsNewTab } from '../_shared/min';

interface Node {
  id: number;
  parent_id: number | null;
  type: 'folder' | 'link';
  title: string;
  url: string | null;
  description: string;
  children?: Node[];
}

const main = shell('bookmarks', '收藏夹');
const treeEl = h('div', { class: 'tree' });
const content = h('div');
const search = h('input', { type: 'search', class: 'search', placeholder: '搜索收藏' });
const importBox = h('div', { class: 'card' });

main.append(
  h('h1', { text: '收藏夹' }),
  h('p', { class: 'subtitle' }, '“收藏夹栏”里的内容显示在地址栏下方。'),
  h('div', { class: 'toolbar' }, search),
  h('div', { class: 'layout' }, h('div', {}, treeEl), content),
  h('h2', { text: '从 Chrome 导入' }),
  importBox,
);

let tree: Node[] = [];
let selected = 1;
const folders = (): { node: Node; depth: number }[] => {
  const out: { node: Node; depth: number }[] = [];
  const walk = (nodes: Node[], depth: number) => {
    for (const n of nodes) {
      if (n.type !== 'folder') continue;
      out.push({ node: n, depth });
      walk(n.children ?? [], depth + 1);
    }
  };
  walk(tree, 0);
  return out;
};
const findFolder = (id: number) => folders().find((f) => f.node.id === id)?.node;

async function load(): Promise<void> {
  tree = await call<Node[]>('bookmarks.tree');
  if (!findFolder(selected)) selected = 1;
  render();
}

function render(): void {
  treeEl.replaceChildren(
    ...folders().map(({ node, depth }) =>
      h('a', {
        class: node.id === selected && !search.value ? 'active' : '',
        style: `padding-left:${10 + depth * 14}px`,
        text: `${depth ? '' : ''}${node.title}`,
        on: {
          click: () => {
            search.value = '';
            selected = node.id;
            render();
          },
        },
      }),
    ),
  );
  if (search.value) {
    void renderSearch();
    return;
  }
  const folder = findFolder(selected)!;
  const items = folder.children ?? [];
  content.replaceChildren(
    h('div', { class: 'toolbar' }, h('strong', { text: folder.title }), h('span', { class: 'grow' })),
    h('div', { class: 'card' }, ...(items.length ? items.map((n, i) => row(n, i, items.length)) : [h('div', { class: 'empty', text: '这个文件夹是空的' })])),
    addForm(folder.id),
  );
}

async function renderSearch(): Promise<void> {
  const results = await call<Node[]>('bookmarks.search', search.value);
  content.replaceChildren(
    h('div', { class: 'card' }, ...(results.length ? results.map((n) => row(n, -1, 0)) : [h('div', { class: 'empty', text: '没有找到匹配的收藏' })])),
  );
}

function row(n: Node, index: number, count: number): HTMLElement {
  const open = (e: Event) => {
    e.preventDefault();
    if (n.type === 'folder') {
      selected = n.id;
      render();
    } else call('bookmarks.open', n.url, wantsNewTab(e as MouseEvent));
  };
  const el = h(
    'div',
    { class: 'row' },
    h('span', { class: 'meta', text: n.type === 'folder' ? '📁' : '🔗' }),
    h(
      'div',
      { class: 'main' },
      h('a', { class: 'title', href: n.url ?? '#', text: n.title, title: n.url ?? '', on: { click: open, auxclick: open } }),
      n.url ? h('span', { class: 'sub', text: [n.description, hostOf(n.url)].filter(Boolean).join(' · ') }) : null,
    ),
  );
  const actions = h('div', { class: 'actions overlay' });
  if (index >= 0) {
    actions.append(
      h('button', { class: 'small', text: '↑', title: '上移', disabled: index === 0, on: { click: () => move(n, n.parent_id!, index - 1) } }),
      h('button', { class: 'small', text: '↓', title: '下移', disabled: index === count - 1, on: { click: () => move(n, n.parent_id!, index + 1) } }),
    );
  }
  const target = h('select', { class: 'small', title: '移动到' }, h('option', { value: '', text: '移动到…' }),
    ...folders().filter((f) => f.node.id !== n.id).map((f) => h('option', { value: String(f.node.id), text: `${'　'.repeat(f.depth)}${f.node.title}` })));
  target.style.height = '28px';
  target.addEventListener('change', () => {
    if (target.value) move(n, Number(target.value), 1e9);
  });
  actions.append(
    target,
    h('button', { class: 'small', text: '编辑', on: { click: () => edit(el, n) } }),
    h('button', {
      class: 'small danger',
      text: '删除',
      on: {
        click: async () => {
          if (n.type === 'folder' && !confirm(`删除文件夹“${n.title}”和里面的所有内容？`)) return;
          await attempt(() => call('bookmarks.remove', n.id));
          load();
        },
      },
    }),
  );
  el.append(actions);
  return el;
}

function edit(el: HTMLElement, n: Node): void {
  const title = h('input', { type: 'text', value: n.title, style: 'flex:1' });
  const url = n.type === 'link' ? h('input', { type: 'url', value: n.url ?? '', style: 'flex:2' }) : null;
  const desc = n.type === 'link' ? h('input', { type: 'text', value: n.description ?? '', placeholder: '描述', style: 'flex:2' }) : null;
  const save = async () => {
    await attempt(() => call('bookmarks.update', n.id, { title: title.value, url: url?.value, description: desc?.value }));
    load();
  };
  el.replaceChildren(title, ...(url ? [url] : []), ...(desc ? [desc] : []), h('button', { class: 'small primary', text: '保存', on: { click: save } }), h('button', { class: 'small', text: '取消', on: { click: render } }));
  title.focus();
}

async function move(n: Node, parent: number, index: number): Promise<void> {
  await attempt(() => call('bookmarks.move', n.id, parent, index));
  load();
}

function addForm(parent: number): HTMLElement {
  const title = h('input', { type: 'text', placeholder: '名称' });
  const url = h('input', { type: 'url', placeholder: 'https://' });
  const desc = h('input', { type: 'text', placeholder: '描述（可选）' });
  const addLink = async () => {
    if (!url.value) return;
    const ok = await attempt(() => call('bookmarks.addLink', parent, title.value, url.value, desc.value));
    if (ok !== undefined) load();
  };
  const addFolder = async () => {
    const ok = await attempt(() => call('bookmarks.addFolder', parent, title.value || '新文件夹'));
    if (ok !== undefined) load();
  };
  return h('div', { class: 'card', style: 'margin-top:16px' },
    h('div', { class: 'form-grid', style: 'grid-template-columns:1fr 1.2fr 1.2fr auto auto' }, title, url, desc, h('button', { class: 'primary', text: '添加网址', on: { click: addLink } }), h('button', { text: '新建文件夹', on: { click: addFolder } })));
}

async function renderImport(): Promise<void> {
  const profiles = await call<{ index: number; browser: string; profile: string }[]>('bookmarks.profiles');
  const doImport = async (fn: () => Promise<{ links: number; folders: number } | null>) => {
    const res = await attempt(fn);
    if (res) {
      toast(`已导入 ${res.links} 个收藏、${res.folders} 个文件夹`);
      load();
    }
  };
  importBox.replaceChildren(
    ...profiles.map((p) =>
      h('div', { class: 'row' },
        h('div', { class: 'main' }, h('span', { class: 'title', text: `${p.browser} · ${p.profile}` }), h('span', { class: 'sub', text: '在这台电脑上找到的浏览器资料' })),
        h('button', { class: 'small primary', text: '导入', on: { click: () => doImport(() => call('bookmarks.importProfile', p.index)) } }))),
    h('div', { class: 'row' },
      h('div', { class: 'main' },
        h('span', { class: 'title', text: profiles.length ? '从文件导入' : '没有自动找到 Chrome，可以从文件导入' }),
        h('span', { class: 'sub', text: 'Chrome 的 Bookmarks 文件，或任何浏览器导出的 bookmarks.html' })),
      h('button', { class: 'small', text: '选择文件…', on: { click: () => doImport(() => call('bookmarks.importFile')) } })),
    h('div', { class: 'row' }, h('span', { class: 'note', text: '收藏夹栏的内容导入到“收藏夹栏”，其他书签导入到“其他收藏 › 从 Chrome 导入”。重复导入不会产生重复项。' })),
  );
}

search.addEventListener('input', () => render());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) load();
});
attempt(async () => {
  await load();
  await renderImport();
});
