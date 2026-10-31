import type { MinBrowserApi, TabState, UiState } from '../shared/ipc';
import { passwordStrength } from '../shared/password';

declare global {
  interface Window {
    minbrowser: MinBrowserApi;
  }
}

const api = window.minbrowser;
const CONFIRM_PHRASE = '我明白忘记密码将无法恢复';

const ICONS = {
  back: '<path d="M10 3 5 8l5 5"/>',
  forward: '<path d="m6 3 5 5-5 5"/>',
  reload: '<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5"/>',
  stop: '<path d="m4 4 8 8M12 4l-8 8"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  star: '<path d="m8 2 1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1L2 6.3l4.2-.5z"/>',
  key: '<circle cx="5.5" cy="10.5" r="2.8"/><path d="m7.5 8.5 6-6M11.5 4.5l1.6 1.6M10 6l1.4 1.4"/>',
  shield: '<path d="M8 1.8 13 3.6v4c0 3-2.1 5.4-5 6.6-2.9-1.2-5-3.6-5-6.6v-4z"/>',
  download: '<path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"/>',
  menu: '<circle cx="3.5" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12.5" cy="8" r=".9" fill="currentColor"/>',
  folder: '<path d="M2 4.5c0-.6.4-1 1-1h3.2l1.5 1.5H13c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z"/>',
  link: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.6 1.6 2.3 3.4 2.3 5.5S9.6 11.9 8 13.5M8 2.5C6.4 4.1 5.7 5.9 5.7 8s.7 3.9 2.3 5.5"/>',
  pause: '<path d="M5.5 3.5v9M10.5 3.5v9"/>',
};

function svg(name: keyof typeof ICONS): string {
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const chrome = $('chrome');
const tabsEl = $('tabs');
const address = $<HTMLInputElement>('address');
const buttons = {
  back: $<HTMLButtonElement>('back'),
  forward: $<HTMLButtonElement>('forward'),
  reload: $<HTMLButtonElement>('reload'),
  newTab: $<HTMLButtonElement>('new-tab'),
  star: $<HTMLButtonElement>('star'),
  key: $<HTMLButtonElement>('key'),
  shield: $<HTMLButtonElement>('shield'),
  record: $<HTMLButtonElement>('record'),
  downloads: $<HTMLButtonElement>('downloads'),
  menu: $<HTMLButtonElement>('menu'),
};
const bar = $('bookmarks-bar');
const infobar = $('infobar');

if (api.platform === 'darwin') document.body.classList.add('mac');
buttons.back.innerHTML = svg('back');
buttons.forward.innerHTML = svg('forward');
buttons.reload.innerHTML = svg('reload');
buttons.newTab.innerHTML = svg('plus');
buttons.star.innerHTML = svg('star');
buttons.key.innerHTML = svg('key');
buttons.shield.insertAdjacentHTML('afterbegin', svg('shield'));
buttons.downloads.insertAdjacentHTML('afterbegin', svg('download'));
buttons.menu.innerHTML = svg('menu');
$('phrase').textContent = CONFIRM_PHRASE;

let state: UiState | null = null;
/** While the user is typing we must not overwrite the address bar. */
let editing = false;

const active = (): TabState | undefined => state?.tabs.find((t) => t.id === state!.activeId);

async function run(name: string, ...args: unknown[]): Promise<unknown> {
  const res = await api.command(name, ...args);
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

/** Fire-and-forget command; errors are logged. */
function send(name: string, ...args: unknown[]): void {
  run(name, ...args).catch((err) => console.warn(name, err));
}

/** Where to pop a native menu: just under the button. */
function below(el: HTMLElement): [number, number] {
  const r = el.getBoundingClientRect();
  return [Math.round(r.left), Math.round(r.bottom + 4)];
}

// ------------------------------------------------------------------ rendering

function render(): void {
  if (!state) return;
  const unlocked = state.phase === 'unlocked';
  chrome.hidden = !unlocked;
  $('overlay').hidden = unlocked;
  $('setup').hidden = state.phase !== 'setup';
  $('unlock').hidden = state.phase !== 'locked';
  if (state.phase === 'locked') {
    $('unlock-dir').textContent = state.dataDir ?? '';
    const pw = $<HTMLInputElement>('unlock-pw');
    if (document.activeElement !== pw) pw.focus();
  }
  if (!unlocked) return;
  renderTabs();
  renderToolbar();
  renderBookmarksBar();
  renderInfobar();
}

interface TabEl {
  root: HTMLElement;
  icon: HTMLElement;
  iconKey: string;
  title: HTMLElement;
}

/**
 * Tab elements are created once per tab and updated in place. Rebuilding them
 * on every state update would swap the element under the pointer between
 * mousedown and mouseup, and the click (e.g. on the close button) would be lost.
 */
const tabEls = new Map<number, TabEl>();

function createTabEl(id: number): TabEl {
  const root = document.createElement('div');
  root.setAttribute('role', 'tab');
  const icon = placeholderIcon();
  const title = document.createElement('span');
  title.className = 'tab-title';
  const close = document.createElement('button');
  close.className = 'icon-button tab-close';
  close.title = '关闭标签页';
  close.innerHTML = svg('close');
  // Don't let pressing the close button also activate (or start dragging) the tab.
  close.addEventListener('mousedown', (e) => e.stopPropagation());
  close.addEventListener('pointerdown', (e) => e.stopPropagation());
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    send('closeTab', id);
  });
  root.append(icon, title, close);
  root.dataset.id = String(id);
  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    send('activateTab', id);
    pressTab(id, root, e);
  });
  root.addEventListener('auxclick', (e) => {
    if (e.button === 1) send('closeTab', id);
  });
  return { root, icon, iconKey: 'placeholder', title };
}

function renderTabs(): void {
  const seen = new Set<number>();
  state!.tabs.forEach((tab, index) => {
    seen.add(tab.id);
    let el = tabEls.get(tab.id);
    if (!el) {
      el = createTabEl(tab.id);
      tabEls.set(tab.id, el);
    }
    el.root.classList.add('tab');
    el.root.classList.toggle('active', tab.id === state!.activeId);
    el.root.title = tab.title;
    if (el.title.textContent !== tab.title) el.title.textContent = tab.title;

    const iconKey = tab.loading ? 'loading' : (tab.favicon ?? 'placeholder');
    if (iconKey !== el.iconKey) {
      let icon: HTMLElement;
      if (tab.loading) {
        icon = document.createElement('span');
        icon.className = 'tab-icon loading';
      } else if (tab.favicon) {
        const img = document.createElement('img');
        img.src = tab.favicon;
        img.className = 'tab-icon';
        img.onerror = () => img.replaceWith(placeholderIcon());
        icon = img;
      } else {
        icon = placeholderIcon();
      }
      el.icon.replaceWith(icon);
      el.icon = icon;
      el.iconKey = iconKey;
    }
    // Keep DOM order in step with tab order without re-creating anything
    // (but not mid-drag: the dragged tab and its neighbours are being moved by hand).
    if (!tabDrag?.active && tabsEl.children[index] !== el.root) tabsEl.insertBefore(el.root, tabsEl.children[index] ?? null);
  });
  for (const [id, el] of tabEls) {
    if (!seen.has(id)) {
      el.root.remove();
      tabEls.delete(id);
    }
  }
}

// ------------------------------------------------------------------ dragging tabs

/**
 * Tabs are reordered by dragging: past a small threshold the tab follows the
 * pointer, the others slide out of its way, and on release it settles into
 * the gap. A press without movement is just a click.
 */
const DRAG_THRESHOLD = 5;

interface TabDrag {
  id: number;
  el: HTMLElement;
  pointerId: number;
  startX: number;
  active: boolean;
  /** Tab elements and their boxes as they were when the drag started. */
  els: HTMLElement[];
  rects: DOMRect[];
  from: number;
  to: number;
}

let tabDrag: TabDrag | null = null;

function pressTab(id: number, el: HTMLElement, e: PointerEvent): void {
  el.setPointerCapture(e.pointerId);
  tabDrag = { id, el, pointerId: e.pointerId, startX: e.clientX, active: false, els: [], rects: [], from: 0, to: 0 };
  el.addEventListener('pointermove', onTabDragMove);
  el.addEventListener('pointerup', onTabDragEnd);
  el.addEventListener('pointercancel', onTabDragCancel);
}

function onTabDragMove(e: PointerEvent): void {
  const d = tabDrag;
  if (!d || e.pointerId !== d.pointerId) return;
  let dx = e.clientX - d.startX;
  if (!d.active) {
    if (Math.abs(dx) < DRAG_THRESHOLD) return;
    d.active = true;
    d.els = Array.from(tabsEl.children) as HTMLElement[];
    d.rects = d.els.map((t) => t.getBoundingClientRect());
    d.from = d.to = d.els.indexOf(d.el);
    d.el.classList.add('dragging');
    tabsEl.classList.add('reordering');
  }
  const { rects, from } = d;
  const me = rects[from];
  // Where would it land? Count the other tabs whose middle the pointer has
  // passed. Use the pointer, not the (clamped) tab, so the ends are reachable.
  const center = me.left + me.width / 2 + dx;
  // Keep the tab itself inside the strip.
  dx = Math.min(Math.max(dx, rects[0].left - me.left), rects[rects.length - 1].right - me.right);
  d.el.style.transform = `translateX(${dx}px)`;

  let to = 0;
  rects.forEach((r, i) => {
    if (i !== from && r.left + r.width / 2 < center) to++;
  });
  d.to = to;

  // Slide the tabs between the old and new place over by one tab width.
  const gap = rects.length > 1 ? Math.max(0, rects[1].left - rects[0].right) : 0;
  const shift = me.width + gap;
  d.els.forEach((t, i) => {
    if (i === from) return;
    let offset = 0;
    if (from < to && i > from && i <= to) offset = -shift;
    if (to < from && i >= to && i < from) offset = shift;
    t.style.transform = offset ? `translateX(${offset}px)` : '';
  });
}

function finishTabDrag(commit: boolean): void {
  const d = tabDrag;
  if (!d) return;
  d.el.removeEventListener('pointermove', onTabDragMove);
  d.el.removeEventListener('pointerup', onTabDragEnd);
  d.el.removeEventListener('pointercancel', onTabDragCancel);
  if (d.el.hasPointerCapture(d.pointerId)) d.el.releasePointerCapture(d.pointerId);
  tabDrag = null;
  if (!d.active) return;
  // Settle without animation: put the element in its new place, then clear the offsets.
  tabsEl.classList.remove('reordering');
  d.el.classList.remove('dragging');
  for (const t of d.els) t.style.transform = '';
  if (commit && d.to !== d.from) {
    const others = d.els.filter((t) => t !== d.el);
    tabsEl.insertBefore(d.el, others[d.to] ?? null);
    send('moveTab', d.id, d.to);
  }
}

function onTabDragEnd(e: PointerEvent): void {
  if (tabDrag && e.pointerId === tabDrag.pointerId) finishTabDrag(true);
}

function onTabDragCancel(e: PointerEvent): void {
  if (tabDrag && e.pointerId === tabDrag.pointerId) finishTabDrag(false);
}

function placeholderIcon(): HTMLElement {
  const el = document.createElement('span');
  el.className = 'tab-icon placeholder';
  return el;
}

function setBadge(button: HTMLElement, value: number): void {
  const badge = button.querySelector<HTMLElement>('.badge')!;
  badge.hidden = value <= 0;
  badge.textContent = value > 99 ? '99+' : String(value);
}

function renderToolbar(): void {
  const tab = active();
  buttons.back.disabled = !tab?.canGoBack;
  buttons.forward.disabled = !tab?.canGoForward;
  buttons.reload.innerHTML = svg(tab?.loading ? 'stop' : 'reload');
  buttons.reload.title = tab?.loading ? '停止' : '重新加载';
  if (!editing) address.value = tab?.url ?? '';

  buttons.star.hidden = !tab?.isWeb;
  buttons.star.classList.toggle('on', !!tab?.bookmarked);
  buttons.star.title = tab?.bookmarked ? '取消收藏' : '收藏此页';

  buttons.key.hidden = !tab?.showKey;

  const shield = tab?.shield ?? 'on';
  buttons.shield.className = `icon-button ${shield}`;
  buttons.shield.hidden = !tab?.isWeb;
  buttons.shield.title =
    shield === 'off'
      ? '广告和追踪拦截已在设置中关闭'
      : shield === 'paused'
        ? '已在此网站停用拦截，点击重新启用'
        : `已拦截 ${tab?.blocked ?? 0} 个广告和追踪请求，点击在此网站停用`;
  setBadge(buttons.shield, shield === 'on' ? (tab?.blocked ?? 0) : 0);

  const paused = state!.recordingPaused;
  buttons.record.classList.toggle('paused', paused);
  buttons.record.innerHTML = paused ? `${svg('pause')}<span>已暂停记录</span>` : '<span class="dot"></span><span>记录中</span>';
  buttons.record.title = paused ? '浏览历史已暂停记录，点击恢复' : '正在记录浏览历史，点击暂停';

  setBadge(buttons.downloads, state!.downloadsActive);
}

let renderedBar = '';

function renderBookmarksBar(): void {
  bar.hidden = !state!.showBookmarksBar;
  if (bar.hidden) return;
  // Only rebuild when the bookmarks changed, so clicks aren't lost to re-renders.
  const key = JSON.stringify(state!.bookmarksBar);
  if (key === renderedBar) return;
  renderedBar = key;
  if (state!.bookmarksBar.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'bar-empty';
    empty.textContent = '点击地址栏中的 ☆ 把网页收藏到这里';
    bar.replaceChildren(empty);
    return;
  }
  bar.replaceChildren(
    ...state!.bookmarksBar.map((item) => {
      const b = document.createElement('button');
      b.className = 'bar-item';
      b.title = [item.title, item.description, item.url].filter(Boolean).join('\n');
      b.innerHTML = svg(item.type === 'folder' ? 'folder' : 'link');
      const label = document.createElement('span');
      label.textContent = item.title;
      b.append(label);
      b.addEventListener('click', (e) => {
        if (item.type === 'folder') send('folderMenu', item.id, ...below(b));
        else send('openBarItem', item.id, e.metaKey || e.ctrlKey);
      });
      b.addEventListener('auxclick', (e) => {
        if (e.button === 1 && item.type === 'link') send('openBarItem', item.id, true);
      });
      return b;
    }),
  );
}

function renderInfobar(): void {
  const p = state!.savePrompt;
  infobar.hidden = !p || p.tabId !== state!.activeId;
  if (!p || infobar.hidden) return;
  const host = p.origin.replace(/^https?:\/\//, '');
  const who = p.username ? `（${p.username}）` : '';
  $('infobar-text').textContent = p.update ? `更新 ${host} 的已保存密码${who}？` : `保存 ${host} 的密码${who}？`;
  $('pw-save').textContent = p.update ? '更新' : '保存';
}

// Keep the main process told how tall the browser chrome is, so pages start below it.
new ResizeObserver(() => {
  if (state?.phase === 'unlocked') send('chromeHeight', chrome.getBoundingClientRect().height);
}).observe(chrome);

api.onState((next) => {
  const switched = next.activeId !== state?.activeId;
  const phaseChanged = next.phase !== state?.phase;
  state = next;
  if (switched) editing = false;
  render();
  if (phaseChanged && next.phase === 'unlocked') send('chromeHeight', chrome.getBoundingClientRect().height);
});

api.onFocusAddress(() => {
  address.focus();
  address.select();
});

// ------------------------------------------------------------------ toolbar

buttons.newTab.addEventListener('click', () => send('newTab'));
buttons.back.addEventListener('click', () => send('back'));
buttons.forward.addEventListener('click', () => send('forward'));
buttons.reload.addEventListener('click', () => send(active()?.loading ? 'stop' : 'reload'));
buttons.star.addEventListener('click', () => send('toggleBookmark'));
buttons.key.addEventListener('click', () => send('passwordMenu', ...below(buttons.key)));
buttons.shield.addEventListener('click', () => send('toggleShield'));
buttons.record.addEventListener('click', () => send('toggleRecording'));
buttons.downloads.addEventListener('click', () => send('openPage', 'downloads'));
buttons.menu.addEventListener('click', () => send('mainMenu', ...below(buttons.menu)));
$('pw-save').addEventListener('click', () => send('savePrompt', 'save'));
$('pw-dismiss').addEventListener('click', () => send('savePrompt', 'dismiss'));
$('pw-never').addEventListener('click', () => send('savePrompt', 'never'));

address.addEventListener('input', () => (editing = true));
address.addEventListener('focus', () => address.select());
address.addEventListener('blur', () => {
  editing = false;
  if (state?.phase === 'unlocked') renderToolbar();
});
address.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    editing = false;
    renderToolbar();
    address.select();
  }
});
$('address-form').addEventListener('submit', (e) => {
  e.preventDefault();
  editing = false;
  send('navigate', address.value);
  address.blur();
});

// Double-clicking empty space in the tab strip opens a new tab.
$('tabbar').addEventListener('dblclick', (e) => {
  if (e.target === e.currentTarget || e.target === tabsEl) send('newTab');
});

// ------------------------------------------------------------------ setup

let setupDir: string | null = null;
const setupError = (msg: string | null) => {
  $('setup-error').hidden = !msg;
  $('setup-error').textContent = msg ?? '';
};

$('setup-choose').addEventListener('click', async () => {
  setupError(null);
  try {
    const res = (await run('setup.chooseDir')) as { dir: string; existing: boolean } | null;
    if (!res) return;
    setupDir = res.dir;
    $('setup-dir').textContent = res.dir;
    $('setup-dir').title = res.dir;
    $('setup-existing').hidden = !res.existing;
    $('setup-form').hidden = res.existing;
    if (!res.existing) $('setup-pw').focus();
  } catch (err) {
    setupError((err as Error).message);
  }
});

$('setup-use').addEventListener('click', () => {
  if (setupDir) run('setup.useExisting', setupDir).catch((err) => setupError(err.message));
});

const STRENGTH = ['太短', '弱', '一般', '较强', '很强'];
$('setup-pw').addEventListener('input', () => {
  const pw = $<HTMLInputElement>('setup-pw').value;
  const s = passwordStrength(pw);
  $('setup-meter').style.width = `${pw ? Math.max(8, s * 25) : 0}%`;
  $('setup-strength').textContent = pw ? `强度：${STRENGTH[s]}` : '至少 8 个字符。建议用一句只有你知道的话。';
});

$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  setupError(null);
  const pw = $<HTMLInputElement>('setup-pw').value;
  const pw2 = $<HTMLInputElement>('setup-pw2').value;
  const phrase = $<HTMLInputElement>('setup-phrase').value;
  if (!setupDir) return setupError('请先选择数据文件夹');
  if (pw.length < 8) return setupError('主密码至少需要 8 个字符');
  if (pw !== pw2) return setupError('两次输入的主密码不一致');
  if (phrase.trim() !== CONFIRM_PHRASE) return setupError(`请输入“${CONFIRM_PHRASE}”以确认`);
  const btn = $<HTMLButtonElement>('setup-create');
  btn.disabled = true;
  btn.textContent = '正在创建加密数据…';
  try {
    await run('setup.create', setupDir, pw, phrase);
    for (const id of ['setup-pw', 'setup-pw2', 'setup-phrase']) $<HTMLInputElement>(id).value = '';
  } catch (err) {
    setupError((err as Error).message);
  } finally {
    btn.disabled = false;
    btn.textContent = '创建并开始浏览';
  }
});

// ------------------------------------------------------------------ unlock

$('unlock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('unlock-pw');
  const btn = $<HTMLButtonElement>('unlock-btn');
  const err = $('unlock-error');
  if (!input.value) return;
  btn.disabled = true;
  btn.textContent = '正在解锁…';
  err.hidden = true;
  try {
    await run('unlock', input.value);
    input.value = '';
  } catch (e2) {
    err.textContent = (e2 as Error).message;
    err.hidden = false;
    input.select();
  } finally {
    btn.disabled = false;
    btn.textContent = '解锁';
  }
});

$('unlock-switch').addEventListener('click', (e) => {
  e.preventDefault();
  send('switchDataDir');
});
