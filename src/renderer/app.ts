import type { MinBrowserApi, TabState, TabsState } from '../shared/ipc';

declare global {
  interface Window {
    minbrowser: MinBrowserApi;
  }
}

const api = window.minbrowser;

const ICONS = {
  back: '<path d="M10 3 5 8l5 5"/>',
  forward: '<path d="m6 3 5 5-5 5"/>',
  reload: '<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5"/>',
  stop: '<path d="m4 4 8 8M12 4l-8 8"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
};

function svg(name: keyof typeof ICONS): string {
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tabsEl = $('tabs');
const address = $<HTMLInputElement>('address');
const backBtn = $<HTMLButtonElement>('back');
const forwardBtn = $<HTMLButtonElement>('forward');
const reloadBtn = $<HTMLButtonElement>('reload');
const newTabBtn = $<HTMLButtonElement>('new-tab');

if (api.platform === 'darwin') document.body.classList.add('mac');

backBtn.innerHTML = svg('back');
forwardBtn.innerHTML = svg('forward');
reloadBtn.innerHTML = svg('reload');
newTabBtn.innerHTML = svg('plus');

let state: TabsState = { tabs: [], activeId: null };
/** While the user is typing we must not overwrite the address bar. */
let editing = false;

const active = (): TabState | undefined => state.tabs.find((t) => t.id === state.activeId);

function renderTabs(): void {
  tabsEl.replaceChildren(
    ...state.tabs.map((tab) => {
      const el = document.createElement('div');
      el.className = 'tab' + (tab.id === state.activeId ? ' active' : '');
      el.setAttribute('role', 'tab');
      el.title = tab.title;

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

      const title = document.createElement('span');
      title.className = 'tab-title';
      title.textContent = tab.title;

      const close = document.createElement('button');
      close.className = 'icon-button tab-close';
      close.title = '关闭标签页';
      close.innerHTML = svg('close');
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        api.closeTab(tab.id);
      });

      el.append(icon, title, close);
      el.addEventListener('mousedown', (e) => {
        if (e.button === 0) api.activateTab(tab.id);
      });
      el.addEventListener('auxclick', (e) => {
        if (e.button === 1) api.closeTab(tab.id);
      });
      return el;
    }),
  );
}

function placeholderIcon(): HTMLElement {
  const el = document.createElement('span');
  el.className = 'tab-icon placeholder';
  return el;
}

function renderToolbar(): void {
  const tab = active();
  backBtn.disabled = !tab?.canGoBack;
  forwardBtn.disabled = !tab?.canGoForward;
  reloadBtn.innerHTML = svg(tab?.loading ? 'stop' : 'reload');
  reloadBtn.title = tab?.loading ? '停止' : '重新加载';
  if (!editing) address.value = tab?.url ?? '';
}

api.onState((next) => {
  const switched = next.activeId !== state.activeId;
  state = next;
  if (switched) editing = false;
  renderTabs();
  renderToolbar();
});

api.onFocusAddress(() => {
  address.focus();
  address.select();
});

newTabBtn.addEventListener('click', () => api.newTab());
backBtn.addEventListener('click', () => api.back());
forwardBtn.addEventListener('click', () => api.forward());
reloadBtn.addEventListener('click', () => (active()?.loading ? api.stop() : api.reload()));

address.addEventListener('input', () => (editing = true));
address.addEventListener('focus', () => address.select());
address.addEventListener('blur', () => {
  editing = false;
  renderToolbar();
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
  const input = address.value;
  editing = false;
  api.navigate(input);
  address.blur();
});

// Double-clicking empty space in the tab strip opens a new tab, like most browsers.
$('tabbar').addEventListener('dblclick', (e) => {
  if (e.target === e.currentTarget || e.target === tabsEl) api.newTab();
});
