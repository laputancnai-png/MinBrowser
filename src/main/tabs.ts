import { BrowserWindow, Session, WebContents, WebContentsView } from 'electron';
import { join } from 'node:path';
import { Ipc, LoginStep, Rect } from '../shared/ipc';
import { clampRatio, Orientation, splitRects } from '../shared/split';
import { NEW_TAB_URL, displayUrl, isInternalUrl, resolveInput } from '../shared/url';
import type { Transition } from './history';

const ERROR_PAGE = 'min://error/';
const DEFAULT_CHROME_HEIGHT = 84;

export interface Tab {
  id: number;
  view: WebContentsView;
  favicon: string | null;
  /** The address that failed to load while the error page is showing. */
  failedUrl: string | null;
  /** How the next navigation was started, if we started it. Anything else is a link. */
  pendingTransition: Transition | null;
  openerId: number | null;
  /** URL without fragment of the last recorded navigation, to ignore #hash-only changes. */
  lastUrl: string;
  blocked: number;
  hasLoginForm: boolean;
  /** Which login step this page shows, as reported by the page agent. */
  loginStep: LoginStep;
  /** Steps already filled automatically on this page (each is filled once). */
  autofilled: Set<'username' | 'password'>;
  /** Username entered on the first step of a multi-step login, for the next step. */
  pendingUsername: { site: string; username: string; at: number } | null;
  /** A restored tab that hasn't been looked at yet: loads when first activated. */
  deferred: { url: string; title: string } | null;
}

export interface TabHooks {
  changed(): void;
  navigated(tab: Tab, url: string, transition: Transition): void;
  titleChanged(tab: Tab, title: string): void;
  closed(tab: Tab): void;
  /** Pages were moved or resized (split ratio, window size, chrome height...). */
  layoutChanged?(): void;
  /** A page got keyboard focus (the user clicked into it). */
  focused?(tab: Tab): void;
}

export interface TabSnapshot {
  id: number;
  title: string;
  url: string;
  pageUrl: string;
  favicon: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  blocked: number;
  hasLoginForm: boolean;
  /** 0 = left/top pane, 1 = right/bottom pane, null = not in the split view. */
  splitPane: 0 | 1 | null;
}

/** Two tabs shown at once. The active tab is the pane that has focus. */
export interface SplitState {
  ids: [number, number];
  orientation: Orientation;
  ratio: number;
}

/** A split view as saved with the session: positions in the saved tab list. */
export interface SavedSplit {
  first: number;
  second: number;
  orientation: Orientation;
  ratio: number;
}

const stripHash = (url: string) => url.split('#', 1)[0];

export class TabManager {
  private tabs = new Map<number, Tab>();
  private order: number[] = [];
  private activeId: number | null = null;
  private nextId = 1;
  private chromeHeight = DEFAULT_CHROME_HEIGHT;
  private visible = true;
  private split: SplitState | null = null;
  /** Tabs whose views are currently in the window. */
  private attached = new Set<number>();

  constructor(
    private readonly win: BrowserWindow,
    private readonly ui: WebContents,
    private readonly session: Session,
    private readonly hooks: TabHooks,
  ) {
    win.on('resize', () => this.layout());
  }

  create(
    url: string = NEW_TAB_URL,
    opts: { activate?: boolean; transition?: Transition; openerId?: number | null; deferredTitle?: string } = {},
  ): number {
    const { activate = true, transition = url === NEW_TAB_URL ? null : 'typed', openerId = null } = opts;
    const id = this.nextId++;
    const view = new WebContentsView({
      webPreferences: {
        session: this.session,
        preload: join(__dirname, '..', 'preload', 'tab.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    });
    view.setBackgroundColor('#ffffff');
    const tab: Tab = {
      id,
      view,
      favicon: null,
      failedUrl: null,
      pendingTransition: transition,
      openerId,
      lastUrl: '',
      blocked: 0,
      hasLoginForm: false,
      loginStep: null,
      autofilled: new Set(),
      pendingUsername: null,
      deferred: null,
    };
    this.tabs.set(id, tab);

    // New tabs go right after the one that opened them, like other browsers.
    const anchor = openerId ?? this.activeId;
    const index = anchor === null ? -1 : this.order.indexOf(anchor);
    this.order.splice(index === -1 ? this.order.length : index + 1, 0, id);

    this.wire(tab);
    if (opts.deferredTitle !== undefined && !activate) tab.deferred = { url, title: opts.deferredTitle };
    else view.webContents.loadURL(url);
    if (activate) this.activate(id);
    else this.hooks.changed();
    if (url === NEW_TAB_URL && activate) this.focusAddress();
    return id;
  }

  close(id: number): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const index = this.order.indexOf(id);
    this.order.splice(index, 1);
    this.tabs.delete(id);
    this.win.contentView.removeChildView(tab.view);
    this.attached.delete(id);
    this.hooks.closed(tab);
    tab.view.webContents.close();

    // Closing either side of a split leaves the other side on its own.
    let next: number | null = null;
    if (this.split?.ids.includes(id)) {
      next = this.split.ids.find((t) => t !== id) ?? null;
      this.split = null;
    }
    if (this.order.length === 0) {
      this.activeId = null;
      this.create();
      return;
    }
    if (this.activeId === id) this.activate(next ?? this.order[Math.min(index, this.order.length - 1)]);
    else if (next !== null) this.syncViews();
    else this.hooks.changed();
  }

  closeActive(): void {
    if (this.activeId !== null) this.close(this.activeId);
  }

  activate(id: number): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    // In a split, picking another tab shows it in the pane that has focus.
    if (this.split && !this.split.ids.includes(id)) {
      const pane = Math.max(0, this.split.ids.indexOf(this.activeId ?? -1));
      this.split.ids[pane] = id;
    }
    this.activeId = id;
    this.syncViews();
    if (this.visible && tab.view.webContents.getURL() !== NEW_TAB_URL) tab.view.webContents.focus();
    this.hooks.changed();
  }

  /** Hide every page, e.g. while the browser is locked. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.syncViews();
  }

  // ---------------------------------------------------------------- split view

  get splitState(): SplitState | null {
    return this.split ? { ...this.split, ids: [...this.split.ids] } : null;
  }

  /**
   * Show `tabId` next to another tab, on the right (horizontal) or below
   * (vertical). Splitting the active tab pairs it with its neighbour; a lone
   * tab gets a new tab beside it. Already split: `tabId` replaces the pane
   * that doesn't have focus.
   */
  splitTab(tabId: number | null, orientation: Orientation): void {
    if (this.activeId === null) return;
    if (this.split) {
      this.split.orientation = orientation;
      if (tabId !== null && !this.split.ids.includes(tabId)) {
        const other = this.split.ids[0] === this.activeId ? 1 : 0;
        this.split.ids[other] = tabId;
      }
      this.activate(tabId ?? this.activeId);
      return;
    }
    let first = this.activeId;
    let second = tabId;
    if (second === first) {
      const i = this.order.indexOf(first);
      const neighbour = this.order[i - 1] ?? this.order[i + 1];
      if (neighbour === undefined) second = null;
      else first = neighbour;
    }
    if (second === null) second = this.create(NEW_TAB_URL, { activate: false });
    this.split = { ids: [first, second], orientation, ratio: 0.5 };
    // Keep the pair next to each other in the tab strip.
    this.order.splice(this.order.indexOf(second), 1);
    this.order.splice(this.order.indexOf(first) + 1, 0, second);
    this.activate(second);
    if (this.tabs.get(second)?.view.webContents.getURL() === NEW_TAB_URL || this.tabs.get(second)?.view.webContents.getURL() === '') {
      this.focusAddress();
    }
  }

  unsplit(): void {
    if (!this.split) return;
    this.split = null;
    this.syncViews();
    this.hooks.changed();
  }

  setSplitOrientation(orientation: Orientation): void {
    if (!this.split || this.split.orientation === orientation) return;
    this.split.orientation = orientation;
    this.layout();
    this.hooks.changed();
  }

  swapSplit(): void {
    if (!this.split) return;
    this.split.ids.reverse();
    this.layout();
    this.hooks.changed();
  }

  setSplitRatio(ratio: number): void {
    if (!this.split) return;
    const r = clampRatio(ratio);
    if (Math.abs(r - this.split.ratio) < 0.001) return;
    this.split.ratio = r;
    this.layout();
    this.hooks.changed();
  }

  /** The area below the browser chrome where pages are shown. */
  contentArea(): Rect {
    const [width, height] = this.win.getContentSize();
    return { x: 0, y: this.chromeHeight, width, height: Math.max(0, height - this.chromeHeight) };
  }

  /** Clicking into one side of a split makes it the active tab. */
  private focusPane(id: number): void {
    if (!this.split?.ids.includes(id) || this.activeId === id) return;
    this.activeId = id;
    this.hooks.changed();
  }

  /** Put exactly the visible tabs' views in the window, and lay them out. */
  private syncViews(): void {
    const want = new Set<number>(!this.visible ? [] : this.split ? this.split.ids : this.activeId !== null ? [this.activeId] : []);
    for (const id of [...this.attached]) {
      if (want.has(id)) continue;
      const t = this.tabs.get(id);
      if (t) this.win.contentView.removeChildView(t.view);
      this.attached.delete(id);
    }
    for (const id of want) {
      const t = this.tabs.get(id);
      if (!t) continue;
      if (t.deferred) {
        const { url } = t.deferred;
        t.deferred = null;
        t.pendingTransition = 'restore';
        t.view.webContents.loadURL(url);
      }
      if (!this.attached.has(id)) {
        this.win.contentView.addChildView(t.view);
        this.attached.add(id);
      }
    }
    this.layout();
  }

  setChromeHeight(px: number): void {
    const h = Math.round(Math.min(Math.max(px, 40), 400));
    if (h === this.chromeHeight) return;
    this.chromeHeight = h;
    this.layout();
  }

  /** Put a tab at position `index` in the tab strip. */
  move(id: number, index: number): void {
    const from = this.order.indexOf(id);
    if (from === -1) return;
    const to = Math.max(0, Math.min(Math.round(index), this.order.length - 1));
    if (to === from) return;
    this.order.splice(from, 1);
    this.order.splice(to, 0, id);
    this.hooks.changed();
  }

  /** Move the active tab one place left (-1) or right (+1). */
  moveActive(delta: number): void {
    if (this.activeId === null) return;
    this.move(this.activeId, this.order.indexOf(this.activeId) + delta);
  }

  /** Move to the tab `delta` positions away, wrapping around. */
  cycle(delta: number): void {
    if (this.activeId === null || this.order.length < 2) return;
    const i = this.order.indexOf(this.activeId);
    this.activate(this.order[(i + delta + this.order.length) % this.order.length]);
  }

  activateIndex(index: number): void {
    const id = index < 0 ? this.order[this.order.length - 1] : this.order[index];
    if (id !== undefined) this.activate(id);
  }

  /** Address bar input: a URL or a search. */
  navigate(input: string): void {
    const url = resolveInput(input);
    if (url) this.load(url, 'typed');
  }

  /** Load a known URL in the active tab. */
  load(url: string, transition: Transition): void {
    const tab = this.active();
    if (!tab) return;
    tab.failedUrl = null;
    tab.pendingTransition = transition;
    tab.view.webContents.loadURL(url);
    tab.view.webContents.focus();
  }

  /** Open an internal page, reusing a tab that already shows it. */
  openInternal(page: string): void {
    const url = `min://${page}/`;
    for (const tab of this.tabs.values()) {
      if (tab.view.webContents.getURL().startsWith(url)) {
        this.activate(tab.id);
        tab.view.webContents.reload();
        return;
      }
    }
    const active = this.active();
    if (active && active.view.webContents.getURL() === NEW_TAB_URL) this.load(url, 'typed');
    else this.create(url);
  }

  back(): void {
    const tab = this.active();
    const h = tab?.view.webContents.navigationHistory;
    if (tab && h?.canGoBack()) {
      tab.pendingTransition = 'back_forward';
      h.goBack();
    }
  }

  forward(): void {
    const tab = this.active();
    const h = tab?.view.webContents.navigationHistory;
    if (tab && h?.canGoForward()) {
      tab.pendingTransition = 'back_forward';
      h.goForward();
    }
  }

  reload(): void {
    const tab = this.active();
    if (!tab) return;
    tab.pendingTransition = 'reload';
    if (tab.failedUrl) tab.view.webContents.loadURL(tab.failedUrl);
    else tab.view.webContents.reload();
  }

  stop(): void {
    this.active()?.view.webContents.stop();
  }

  toggleDevTools(): void {
    this.active()?.view.webContents.toggleDevTools();
  }

  focusAddress(): void {
    this.ui.focus();
    this.ui.send(Ipc.FocusAddress);
  }

  active(): Tab | undefined {
    return this.activeId === null ? undefined : this.tabs.get(this.activeId);
  }

  get(id: number): Tab | undefined {
    return this.tabs.get(id);
  }

  byWebContents(wc: WebContents): Tab | undefined {
    for (const tab of this.tabs.values()) if (tab.view.webContents === wc) return tab;
    return undefined;
  }

  byWebContentsId(id: number): Tab | undefined {
    for (const tab of this.tabs.values()) if (!tab.view.webContents.isDestroyed() && tab.view.webContents.id === id) return tab;
    return undefined;
  }

  all(): Tab[] {
    return this.order.map((id) => this.tabs.get(id)!);
  }

  get activeTabId(): number | null {
    return this.activeId;
  }

  /** Current URL of a tab as the user sees it (the failed address on error pages). */
  pageUrl(tab: Tab): string {
    return tab.deferred?.url ?? tab.failedUrl ?? tab.view.webContents.getURL();
  }

  /**
   * Bring back saved tabs. Only the active one loads now; the others load
   * when they are first opened, so restoring many tabs stays fast.
   */
  restore(tabs: { url: string; title: string }[], activeIndex: number, split?: SavedSplit | null): void {
    const ids = tabs.map((t) => this.create(t.url, { activate: false, deferredTitle: t.title, transition: 'restore' }));
    const active = ids[Math.min(Math.max(activeIndex, 0), ids.length - 1)];
    if (split && ids[split.first] !== undefined && ids[split.second] !== undefined && split.first !== split.second) {
      this.split = { ids: [ids[split.first], ids[split.second]], orientation: split.orientation, ratio: clampRatio(split.ratio) };
      this.activeId = this.split.ids[0];
      this.activate(this.split.ids.includes(active) ? active : this.split.ids[0]);
      return;
    }
    this.activate(active);
  }

  /** What to save so the tabs can be restored: real pages only, in order. */
  sessionTabs(): { tabs: { url: string; title: string }[]; activeIndex: number; split: SavedSplit | null } {
    const tabs: { url: string; title: string }[] = [];
    const indexOf = new Map<number, number>();
    let activeIndex = 0;
    for (const tab of this.all()) {
      if (tab.view.webContents.isDestroyed()) continue;
      const url = this.pageUrl(tab);
      if (!url || url === NEW_TAB_URL || url === 'about:blank' || url.startsWith(ERROR_PAGE)) continue;
      if (tab.id === this.activeId) activeIndex = tabs.length;
      indexOf.set(tab.id, tabs.length);
      tabs.push({ url, title: tab.deferred?.title ?? tab.view.webContents.getTitle() });
    }
    let split: SavedSplit | null = null;
    if (this.split) {
      const [a, b] = this.split.ids.map((id) => indexOf.get(id));
      if (a !== undefined && b !== undefined) split = { first: a, second: b, orientation: this.split.orientation, ratio: this.split.ratio };
    }
    return { tabs, activeIndex, split };
  }

  snapshot(): TabSnapshot[] {
    return this.all().map((tab) => {
      const wc = tab.view.webContents;
      const url = this.pageUrl(tab);
      let title = tab.deferred?.title || wc.getTitle();
      if (url === NEW_TAB_URL) title = '新标签页';
      else if (!title || title === url) title = displayUrl(url).replace(/^https?:\/\/(www\.)?/, '');
      return {
        id: tab.id,
        url: displayUrl(url),
        pageUrl: url,
        title,
        favicon: tab.favicon,
        loading: !tab.deferred && wc.isLoading(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        blocked: tab.blocked,
        hasLoginForm: tab.hasLoginForm,
        splitPane: this.split ? ((this.split.ids.indexOf(tab.id) as 0 | 1 | -1) === -1 ? null : (this.split.ids.indexOf(tab.id) as 0 | 1)) : null,
      };
    });
  }

  private layout(): void {
    if (this.visible) {
      const area = this.contentArea();
      if (this.split) {
        const { first, second } = splitRects(area, this.split.orientation, this.split.ratio);
        this.tabs.get(this.split.ids[0])?.view.setBounds(first);
        this.tabs.get(this.split.ids[1])?.view.setBounds(second);
      } else {
        this.active()?.view.setBounds(area);
      }
    }
    this.hooks.layoutChanged?.();
  }

  private wire(tab: Tab): void {
    const wc = tab.view.webContents;
    const update = () => this.hooks.changed();

    wc.on('page-title-updated', (_e, title) => {
      if (!wc.getURL().startsWith(ERROR_PAGE)) this.hooks.titleChanged(tab, title);
      update();
    });
    wc.on('did-start-loading', update);
    wc.on('focus', () => {
      this.focusPane(tab.id);
      this.hooks.focused?.(tab);
    });
    wc.on('did-stop-loading', update);
    // Reset the blocked counter when the navigation starts: the new page's first
    // requests can be blocked before 'did-navigate' reaches us.
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        tab.blocked = 0;
        // Same race for the login form report from the new page.
        tab.hasLoginForm = false;
        tab.loginStep = null;
        tab.autofilled.clear();
      }
    });
    wc.on('did-navigate', (_e, url) => {
      tab.favicon = null;
      if (!url.startsWith(ERROR_PAGE)) {
        tab.failedUrl = null;
        tab.lastUrl = stripHash(url);
        this.hooks.navigated(tab, url, tab.pendingTransition ?? 'link');
      }
      tab.pendingTransition = null;
      update();
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      // Single-page apps change the path with pushState; a #fragment alone is not a new page.
      if (stripHash(url) !== tab.lastUrl) {
        tab.lastUrl = stripHash(url);
        tab.autofilled.clear();
        this.hooks.navigated(tab, url, tab.pendingTransition ?? 'link');
      }
      tab.pendingTransition = null;
      update();
    });
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      // -3 is ERR_ABORTED: the user stopped or navigated away, not a real failure.
      if (!isMainFrame || code === -3 || url.startsWith(ERROR_PAGE)) return;
      tab.failedUrl = url;
      tab.pendingTransition = null;
      const query = new URLSearchParams({ code: description, url });
      wc.loadURL(`${ERROR_PAGE}?${query}`);
    });
    // A crashed page shows the error page instead of going blank; reload brings it back.
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      const url = wc.getURL();
      if (!url || url.startsWith(ERROR_PAGE) || isInternalUrl(url)) {
        if (url && isInternalUrl(url) && !url.startsWith(ERROR_PAGE)) wc.loadURL(url);
        return;
      }
      tab.failedUrl = url;
      const query = new URLSearchParams({ code: `RENDERER_CRASHED (${details.reason})`, url });
      wc.loadURL(`${ERROR_PAGE}?${query}`);
      update();
    });
    wc.on('page-favicon-updated', async (_e, favicons) => {
      const pageUrl = wc.getURL();
      const icon = await this.loadFavicon(favicons);
      if (wc.isDestroyed() || wc.getURL() !== pageUrl) return;
      tab.favicon = icon;
      update();
    });

    // Popups and target=_blank links open as a new tab next to this one.
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (/^https?:/.test(url)) {
        this.create(url, { transition: 'link', openerId: tab.id, activate: disposition !== 'background-tab' });
      }
      return { action: 'deny' };
    });

    // Web pages may not navigate into internal min:// pages; only the browser can.
    wc.on('will-navigate', (event, url) => {
      if (isInternalUrl(url) && !isInternalUrl(wc.getURL())) event.preventDefault();
    });
    wc.on('will-redirect', (event, url) => {
      if (isInternalUrl(url)) event.preventDefault();
    });
  }

  /**
   * Fetch the favicon through the web session (so it gets the same cookie and
   * tracker rules as the page) and hand the UI a data: URL. The UI itself never
   * talks to the network.
   */
  private async loadFavicon(candidates: string[]): Promise<string | null> {
    const url = candidates.find((f) => /^(https?|data):/.test(f));
    if (!url || url.startsWith('data:')) return url ?? null;
    try {
      const res = await this.session.fetch(url, { credentials: 'omit' });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !type.startsWith('image/')) return null;
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length > 256 * 1024) return null;
      return `data:${type.split(';')[0]};base64,${body.toString('base64')}`;
    } catch {
      return null;
    }
  }
}
