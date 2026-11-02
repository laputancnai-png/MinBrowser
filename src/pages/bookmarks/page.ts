import { attempt, call, h, hostOf, shell, toast } from '../_shared/min';

// Visual bookmark manager: a collapsible folder tree on the left, the open
// folder's contents on the right (list or cards). Everything can be dragged:
// between items to reorder, onto a folder (in the list, the tree or the path
// bar) to move it there. Ctrl/⌘-click and Shift-click select several items.

interface Node {
  id: number;
  parent_id: number | null;
  type: 'folder' | 'link';
  title: string;
  url: string | null;
  description: string;
  children?: Node[];
}

const ROOT_BAR = 1;
const END = 1_000_000;

// ------------------------------------------------------------------ state

let roots: Node[] = [];
const byId = new Map<number, Node>();
const linkCounts = new Map<number, number>();
let current = ROOT_BAR;
const expanded = new Set<number>([ROOT_BAR, 2]);
const selected = new Set<number>();
let anchor: number | null = null;
let view: 'list' | 'grid' = localStorage.getItem('bm-view') === 'grid' ? 'grid' : 'list';
let query = '';
let results: Node[] = [];
/** Ids being dragged, in display order. Kept here rather than only in dataTransfer. */
let dragIds: number[] | null = null;

// ------------------------------------------------------------------ layout

const main = shell('bookmarks', '收藏夹');
main.className = 'bm';

const treeEl = h('div', { class: 'bm-tree' });
const crumbs = h('div', { class: 'crumbs' });
const search = h('input', { type: 'search', placeholder: '搜索标题、网址或描述' });
const listBtn = h('button', { text: '列表', title: '列表视图' });
const gridBtn = h('button', { text: '卡片', title: '卡片视图' });
const selbar = h('div', { class: 'bm-selbar', hidden: true });
const itemsEl = h('div', { class: 'items' });
const scroller = h('div', { class: 'bm-scroll' }, itemsEl, h('p', { class: 'bm-hint', text: '拖动可以排序，拖到文件夹上可以移进去 · 双击打开 · Ctrl/⌘ 或 Shift 点击可多选 · Delete 删除' }));

main.append(
  h('aside', { class: 'bm-side' }, h('h2', { text: '文件夹' }), treeEl),
  h(
    'section',
    { class: 'bm-main' },
    h(
      'div',
      { class: 'bm-toolbar' },
      crumbs,
      search,
      h('div', { class: 'seg' }, listBtn, gridBtn),
      h('button', { text: '新建文件夹', on: { click: () => newFolder() } }),
      h('button', { class: 'primary', text: '添加网址', on: { click: () => editDialog(null) } }),
      h('button', { text: '导入…', on: { click: () => importDialog() } }),
      h('button', { text: '导出…', on: { click: () => exportBookmarks() } }),
    ),
    selbar,
    scroller,
  ),
);

// ------------------------------------------------------------------ data

async function load(): Promise<void> {
  roots = await call<Node[]>('bookmarks.tree');
  byId.clear();
  linkCounts.clear();
  const index = (n: Node): number => {
    byId.set(n.id, n);
    if (n.type === 'link') return 1;
    const count = (n.children ?? []).reduce((s, c) => s + index(c), 0);
    linkCounts.set(n.id, count);
    return count;
  };
  roots.forEach(index);
  if (byId.get(current)?.type !== 'folder') current = ROOT_BAR;
  for (const id of [...selected]) if (!byId.has(id)) selected.delete(id);
  if (query) results = await call<Node[]>('bookmarks.search', query);
  render();
}

const children = (id: number) => byId.get(id)?.children ?? [];
const pathTo = (id: number): Node[] => {
  const out: Node[] = [];
  for (let n = byId.get(id); n; n = n.parent_id === null ? undefined : byId.get(n.parent_id)) out.unshift(n);
  return out;
};
/** Is `folderId` the item itself or somewhere inside it? */
const isInside = (folderId: number, itemId: number) => pathTo(folderId).some((n) => n.id === itemId);
const visibleItems = (): Node[] => (query ? results : children(current));

// ------------------------------------------------------------------ rendering

const FOLDER_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2 4.5c0-.6.4-1 1-1h3.2l1.5 1.5H13c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z"/></svg>';
const PALETTE = ['#D97757', '#C2410C', '#B45309', '#4D7C0F', '#0F766E', '#0369A1', '#6D28D9', '#BE185D', '#57534E', '#9A3412'];

function avatar(n: Node): HTMLElement {
  if (n.type === 'folder') {
    const a = h('div', { class: 'avatar folder' });
    a.innerHTML = FOLDER_SVG;
    return a;
  }
  const host = hostOf(n.url ?? '').replace(/^www\./, '');
  let hash = 0;
  for (const ch of host) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const a = h('div', { class: 'avatar', text: (host[0] ?? n.title[0] ?? '?').toUpperCase() });
  a.style.background = PALETTE[hash % PALETTE.length];
  return a;
}

function render(): void {
  renderTree();
  renderCrumbs();
  renderItems();
  renderSelbar();
  listBtn.className = view === 'list' ? 'on' : '';
  gridBtn.className = view === 'grid' ? 'on' : '';
}

function renderTree(): void {
  const node = (n: Node, depth: number): HTMLElement => {
    const subfolders = (n.children ?? []).filter((c) => c.type === 'folder');
    const open = expanded.has(n.id);
    const caret = h('span', { class: `caret${subfolders.length ? (open ? ' open' : '') : ' none'}`, text: '▶' });
    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      if (open) expanded.delete(n.id);
      else expanded.add(n.id);
      renderTree();
    });
    const icon = h('span', { class: 'ficon' });
    icon.innerHTML = FOLDER_SVG;
    const row = h(
      'div',
      { class: `tnode-row${n.id === current && !query ? ' current' : ''}`, title: n.title },
      caret,
      icon,
      h('span', { class: 'name', text: n.title }),
      h('span', { class: 'count', text: String(linkCounts.get(n.id) ?? 0) }),
    );
    row.style.paddingLeft = `${6 + depth * 16}px`;
    row.addEventListener('click', () => openFolder(n.id));
    const isRoot = n.parent_id === null;
    if (!isRoot) makeDraggable(row, n.id);
    // Roots only accept drops into them; other folders can also be reordered.
    makeDropTarget(row, { folder: n, vertical: true, beside: !isRoot });
    const wrap = h('div', {}, row);
    if (open) for (const c of subfolders) wrap.append(node(c, depth + 1));
    return wrap;
  };
  treeEl.replaceChildren(...roots.map((r) => node(r, 0)));
}

function renderCrumbs(): void {
  if (query) {
    crumbs.replaceChildren(h('a', { text: `搜索“${query}”：${results.length} 个结果` }));
    return;
  }
  const parts: HTMLElement[] = [];
  for (const n of pathTo(current)) {
    if (parts.length) parts.push(h('span', { class: 'sep', text: '›' }));
    const a = h('a', { text: n.title, on: { click: () => openFolder(n.id) } });
    makeDropTarget(a, { folder: n, vertical: false, beside: false });
    parts.push(a);
  }
  crumbs.replaceChildren(...parts);
}

function renderItems(): void {
  itemsEl.className = `items ${view}`;
  const items = visibleItems();
  if (items.length === 0) {
    itemsEl.replaceChildren(h('div', { class: 'empty-folder', text: query ? '没有找到匹配的收藏' : '这个文件夹是空的，可以把收藏拖到这里' }));
    return;
  }
  itemsEl.replaceChildren(...items.map(itemEl));
}

function itemEl(n: Node): HTMLElement {
  const meta =
    n.type === 'folder'
      ? `${linkCounts.get(n.id) ?? 0} 个收藏`
      : query
        ? `${pathTo(n.parent_id!).map((p) => p.title).join(' › ')} · ${hostOf(n.url ?? '')}`
        : hostOf(n.url ?? '');
  const quick = h(
    'div',
    { class: 'quick' },
    n.type === 'link' ? h('button', { text: '打开', title: '在新标签页打开', on: { click: (e) => (e.stopPropagation(), open(n, true)) } }) : null,
    h('button', { text: '编辑', on: { click: (e) => (e.stopPropagation(), editDialog(n)) } }),
  );
  const el = h(
    'div',
    { class: `item${selected.has(n.id) ? ' selected' : ''}`, title: [n.title, n.description, n.url].filter(Boolean).join('\n') },
    avatar(n),
    h(
      'div',
      { class: 'text' },
      h('span', { class: 'title', text: n.title }),
      n.description ? h('span', { class: 'desc', text: n.description }) : null,
      h('span', { class: 'meta', text: meta }),
    ),
    quick,
  );
  el.dataset.id = String(n.id);
  el.addEventListener('click', (e) => select(n.id, e));
  el.addEventListener('dblclick', () => open(n, false));
  el.addEventListener('auxclick', (e) => {
    if (e.button === 1 && n.type === 'link') open(n, true);
  });
  makeDraggable(el, n.id);
  if (!query || n.type === 'folder') {
    makeDropTarget(el, { folder: n.type === 'folder' ? n : null, vertical: view === 'list', beside: !query, item: n });
  }
  return el;
}

function renderSelbar(): void {
  selbar.hidden = selected.size === 0;
  if (selbar.hidden) return;
  const ids = [...selected];
  const target = h('select', {}, h('option', { value: '', text: '移动到…' }), ...folderOptions(ids));
  target.addEventListener('change', async () => {
    if (!target.value) return;
    await moveTo(ids, Number(target.value), END);
  });
  const links = ids.map((id) => byId.get(id)).filter((n): n is Node => n?.type === 'link');
  const parts: (HTMLElement | null)[] = [
    h('strong', { text: `已选 ${ids.length} 项` }),
    target,
    links.length ? h('button', { class: 'small', text: `在新标签页打开 ${links.length} 个`, on: { click: () => links.forEach((l) => open(l, true)) } }) : null,
    ids.length === 1 ? h('button', { class: 'small', text: '编辑', on: { click: () => editDialog(byId.get(ids[0])!) } }) : null,
    h('button', { class: 'small danger', text: '删除', on: { click: () => removeSelected() } }),
    h('span', { class: 'grow' }),
    h('button', { class: 'small', text: '取消选择', on: { click: () => (selected.clear(), render()) } }),
  ];
  selbar.replaceChildren(...parts.filter((p): p is HTMLElement => p !== null));
}

/** Folder <option>s, indented, leaving out anywhere the given items can't go. */
function folderOptions(movingIds: number[]): HTMLOptionElement[] {
  const out: HTMLOptionElement[] = [];
  const walk = (nodes: Node[], depth: number) => {
    for (const n of nodes) {
      if (n.type !== 'folder') continue;
      if (movingIds.some((id) => isInside(n.id, id))) continue;
      out.push(h('option', { value: String(n.id), text: `${'　'.repeat(depth)}${n.title}` }));
      walk(n.children ?? [], depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

// ------------------------------------------------------------------ selection & opening

function select(id: number, e: MouseEvent): void {
  const items = visibleItems().map((n) => n.id);
  if (e.shiftKey && anchor !== null && items.includes(anchor)) {
    const [a, b] = [items.indexOf(anchor), items.indexOf(id)].sort((x, y) => x - y);
    if (!(e.metaKey || e.ctrlKey)) selected.clear();
    for (const i of items.slice(a, b + 1)) selected.add(i);
  } else if (e.metaKey || e.ctrlKey) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    anchor = id;
  } else {
    selected.clear();
    selected.add(id);
    anchor = id;
  }
  renderItems();
  renderSelbar();
}

function openFolder(id: number): void {
  current = id;
  query = '';
  search.value = '';
  selected.clear();
  anchor = null;
  for (const n of pathTo(id)) expanded.add(n.id);
  render();
  scroller.scrollTop = 0;
}

function open(n: Node, newTab: boolean): void {
  if (n.type === 'folder') openFolder(n.id);
  else if (n.url) call('bookmarks.open', n.url, newTab);
}

// ------------------------------------------------------------------ drag & drop

function makeDraggable(el: HTMLElement, id: number): void {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    if (!selected.has(id)) {
      selected.clear();
      selected.add(id);
      anchor = id;
      renderSelbar();
    }
    // Keep the order the items have on screen.
    const order = visibleItems().map((n) => n.id);
    dragIds = [...selected].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    e.dataTransfer?.setData('text/plain', dragIds.map((i) => byId.get(i)?.url ?? byId.get(i)?.title).join('\n'));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    if (dragIds.length > 1 && e.dataTransfer) {
      const ghost = h('div', { class: 'drag-ghost', text: `${dragIds.length} 项` });
      document.body.append(ghost);
      e.dataTransfer.setDragImage(ghost, 10, 10);
      setTimeout(() => ghost.remove(), 0);
    }
    for (const i of dragIds) itemsEl.querySelector(`[data-id="${i}"]`)?.classList.add('dragging');
  });
  el.addEventListener('dragend', () => endDrag());
}

function endDrag(): void {
  dragIds = null;
  document.querySelectorAll('.dragging, .drop-before, .drop-after, .drop-into, .drop-end').forEach((n) =>
    n.classList.remove('dragging', 'drop-before', 'drop-after', 'drop-into', 'drop-end'),
  );
}

type Zone = 'before' | 'after' | 'into';

interface DropSpec {
  /** The folder this element stands for, if items can be dropped into it. */
  folder: Node | null;
  /** Reorder along the vertical axis (lists, tree) or horizontal (cards, path bar). */
  vertical: boolean;
  /** Whether dropping before/after this element is allowed. */
  beside: boolean;
  /** The item shown (for before/after); defaults to the folder. */
  item?: Node;
}

function zoneFor(e: DragEvent, el: HTMLElement, spec: DropSpec): Zone | null {
  if (!dragIds) return null;
  const item = spec.item ?? spec.folder;
  if (item && dragIds.includes(item.id)) return null;
  const r = el.getBoundingClientRect();
  const pos = spec.vertical ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
  const canInto = !!spec.folder && !dragIds.some((id) => isInside(spec.folder!.id, id));
  if (canInto && (!spec.beside || (pos > 0.25 && pos < 0.75))) return 'into';
  if (!spec.beside || !item || item.parent_id === null) return null;
  if (dragIds.some((id) => isInside(item.parent_id!, id))) return null;
  return pos < 0.5 ? 'before' : 'after';
}

function makeDropTarget(el: HTMLElement, spec: DropSpec): void {
  el.addEventListener('dragover', (e) => {
    const zone = zoneFor(e, el, spec);
    el.classList.remove('drop-before', 'drop-after', 'drop-into');
    if (!zone) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    el.classList.add(`drop-${zone}`);
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after', 'drop-into'));
  el.addEventListener('drop', (e) => {
    const zone = zoneFor(e, el, spec);
    const ids = dragIds;
    endDrag();
    if (!zone || !ids) return;
    e.preventDefault();
    e.stopPropagation();
    if (zone === 'into') {
      void moveTo(ids, spec.folder!.id, END);
      return;
    }
    const item = (spec.item ?? spec.folder)!;
    const siblings = children(item.parent_id!).filter((s) => !ids.includes(s.id));
    const index = siblings.findIndex((s) => s.id === item.id) + (zone === 'after' ? 1 : 0);
    void moveTo(ids, item.parent_id!, index);
  });
}

// Dropping on empty space in the list appends to the open folder.
scroller.addEventListener('dragover', (e) => {
  if (!dragIds || query || dragIds.some((id) => isInside(current, id))) return;
  e.preventDefault();
  scroller.classList.add('drop-end');
});
scroller.addEventListener('dragleave', (e) => {
  if (e.target === scroller) scroller.classList.remove('drop-end');
});
scroller.addEventListener('drop', (e) => {
  const ids = dragIds;
  endDrag();
  if (!ids || query) return;
  e.preventDefault();
  void moveTo(ids, current, END);
});

async function moveTo(ids: number[], parent: number, index: number): Promise<void> {
  let moved = true;
  await attempt(async () => {
    try {
      await call('bookmarks.moveMany', ids, parent, index);
    } catch (err) {
      moved = false;
      throw err;
    }
  });
  if (moved && parent !== current && byId.get(parent)) toast(`已移动 ${ids.length} 项到“${byId.get(parent)!.title}”`);
  await load();
}

// ------------------------------------------------------------------ editing

function editDialog(n: Node | null): void {
  const isFolder = n?.type === 'folder';
  const title = h('input', { type: 'text', value: n?.title ?? '', placeholder: '名称' });
  const url = h('input', { type: 'url', value: n?.url ?? '', placeholder: 'https://' });
  const desc = h('textarea', { placeholder: '一句话说明这是什么（可选）' });
  desc.value = n?.description ?? '';
  const error = h('p', { class: 'error', hidden: true });
  const dlg = h('dialog', {});
  const save = async () => {
    try {
      if (!n) {
        if (!url.value.trim()) throw new Error('请输入网址');
        await call('bookmarks.addLink', current, title.value, url.value.trim(), desc.value);
      } else if (isFolder) {
        await call('bookmarks.update', n.id, { title: title.value });
      } else {
        await call('bookmarks.update', n.id, { title: title.value, url: url.value.trim(), description: desc.value });
      }
      dlg.close();
      await load();
    } catch (err) {
      error.textContent = String((err as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      error.hidden = false;
    }
  };
  const form = h(
    'form',
    { on: { submit: (e) => (e.preventDefault(), save()) } },
    h('h3', { text: !n ? `添加网址到“${byId.get(current)?.title}”` : isFolder ? '重命名文件夹' : '编辑收藏' }),
    h('label', { text: '名称' }),
    title,
    ...(isFolder ? [] : [h('label', { text: '网址' }), url, h('label', { text: '描述' }), desc]),
    error,
    h('div', { class: 'actions-row' }, h('button', { type: 'button', text: '取消', on: { click: () => dlg.close() } }), h('button', { class: 'primary', type: 'submit', text: '保存' })),
  );
  dlg.append(form);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  (n || isFolder ? title : url).focus();
}

async function newFolder(): Promise<void> {
  const parent = query ? ROOT_BAR : current;
  const id = await attempt(() => call<number>('bookmarks.addFolder', parent, '新文件夹'));
  if (id === undefined) return;
  expanded.add(parent);
  await load();
  editDialog(byId.get(id)!);
}

async function removeSelected(): Promise<void> {
  const ids = [...selected];
  const folders = ids.filter((id) => byId.get(id)?.type === 'folder');
  const inside = folders.reduce((s, id) => s + (linkCounts.get(id) ?? 0), 0);
  const msg =
    ids.length === 1
      ? `删除“${byId.get(ids[0])?.title}”${folders.length ? `和里面的 ${inside} 个收藏` : ''}？`
      : `删除选中的 ${ids.length} 项${inside ? `（其中文件夹里还有 ${inside} 个收藏）` : ''}？`;
  if (!confirm(msg)) return;
  await attempt(() => call('bookmarks.removeMany', ids));
  selected.clear();
  await load();
}

// ------------------------------------------------------------------ export

async function exportBookmarks(): Promise<void> {
  if (!confirm('导出的文件不加密，任何能打开这个文件的人都能看到你的收藏。继续导出吗？')) return;
  const res = await attempt(() => call<{ path: string; count: number } | null>('bookmarks.export'));
  if (res) toast(`已导出 ${res.count} 个收藏到 ${res.path}`);
}

// ------------------------------------------------------------------ import

async function importDialog(): Promise<void> {
  const profiles = await call<{ index: number; browser: string; profile: string }[]>('bookmarks.profiles');
  const dlg = h('dialog', {});
  const run = async (fn: () => Promise<{ links: number; folders: number } | null>) => {
    const res = await attempt(fn);
    if (!res) return;
    dlg.close();
    toast(`已导入 ${res.links} 个收藏、${res.folders} 个文件夹`);
    await load();
  };
  dlg.append(
    h('h3', { text: '导入收藏' }),
    ...profiles.map((p) =>
      h('div', { class: 'row' }, h('div', { class: 'main' }, h('span', { class: 'title', text: `${p.browser} · ${p.profile}` }), h('span', { class: 'sub', text: '在这台电脑上找到的浏览器资料' })),
        h('button', { class: 'small primary', text: '导入', on: { click: () => run(() => call('bookmarks.importProfile', p.index)) } })),
    ),
    h('div', { class: 'row' }, h('div', { class: 'main' }, h('span', { class: 'title', text: '从文件导入' }), h('span', { class: 'sub', text: 'Chrome 的 Bookmarks 文件，或任何浏览器导出的 bookmarks.html' })),
      h('button', { class: 'small', text: '选择文件…', on: { click: () => run(() => call('bookmarks.importFile')) } })),
    h('p', { class: 'note', text: '重复的网址不会再导入一次；已有收藏缺少的描述会被补上。' }),
    h('div', { class: 'actions-row' }, h('button', { text: '关闭', on: { click: () => dlg.close() } })),
  );
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

// ------------------------------------------------------------------ wiring

listBtn.addEventListener('click', () => {
  view = 'list';
  localStorage.setItem('bm-view', view);
  render();
});
gridBtn.addEventListener('click', () => {
  view = 'grid';
  localStorage.setItem('bm-view', view);
  render();
});

let searchTimer: number | undefined;
search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(async () => {
    query = search.value.trim();
    selected.clear();
    results = query ? await call<Node[]>('bookmarks.search', query) : [];
    render();
  }, 150);
});

// Clicking empty space clears the selection.
scroller.addEventListener('click', (e) => {
  if (e.target === scroller || e.target === itemsEl) {
    selected.clear();
    renderItems();
    renderSelbar();
  }
});

document.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || document.querySelector('dialog[open]');
  if (typing) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size) {
    e.preventDefault();
    void removeSelected();
  } else if (e.key === 'Escape' && selected.size) {
    selected.clear();
    render();
  } else if (e.key === 'Enter' && selected.size === 1) {
    open(byId.get([...selected][0])!, false);
  } else if (e.key === 'a' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    for (const n of visibleItems()) selected.add(n.id);
    renderItems();
    renderSelbar();
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !dragIds) void load();
});

attempt(load);
