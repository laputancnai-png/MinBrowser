import { BrowserWindow, Session, WebContents, WebContentsView } from 'electron';
import { join } from 'node:path';
import { Ipc } from '../shared/ipc';
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
}

export interface TabHooks {
  changed(): void;
  navigated(tab: Tab, url: string, transition: Transition): void;
  titleChanged(tab: Tab, title: string): void;
  closed(tab: Tab): void;
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
}

const stripHash = (url: string) => url.split('#', 1)[0];

export class TabManager {
  private tabs = new Map<number, Tab>();
  private order: number[] = [];
  private activeId: number | null = null;
  private nextId = 1;
  private chromeHeight = DEFAULT_CHROME_HEIGHT;
  private visible = true;

  constructor(
    private readonly win: BrowserWindow,
    private readonly ui: WebContents,
    private readonly session: Session,
    private readonly hooks: TabHooks,
  ) {
    win.on('resize', () => this.layout());
  }

  create(url: string = NEW_TAB_URL, opts: { activate?: boolean; transition?: Transition; openerId?: number | null } = {}): number {
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
    };
    this.tabs.set(id, tab);

    // New tabs go right after the one that opened them, like other browsers.
    const anchor = openerId ?? this.activeId;
    const index = anchor === null ? -1 : this.order.indexOf(anchor);
    this.order.splice(index === -1 ? this.order.length : index + 1, 0, id);

    this.wire(tab);
    view.webContents.loadURL(url);
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
    this.hooks.closed(tab);
    tab.view.webContents.close();

    if (this.order.length === 0) {
      this.activeId = null;
      this.create();
      return;
    }
    if (this.activeId === id) this.activate(this.order[Math.min(index, this.order.length - 1)]);
    else this.hooks.changed();
  }

  closeActive(): void {
    if (this.activeId !== null) this.close(this.activeId);
  }

  activate(id: number): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const prev = this.active();
    if (prev && prev !== tab) this.win.contentView.removeChildView(prev.view);
    this.activeId = id;
    if (this.visible) {
      this.win.contentView.addChildView(tab.view);
      this.layout();
      if (tab.view.webContents.getURL() !== NEW_TAB_URL) tab.view.webContents.focus();
    }
    this.hooks.changed();
  }

  /** Hide every page, e.g. while the browser is locked. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    const tab = this.active();
    if (!tab) return;
    if (visible) {
      this.win.contentView.addChildView(tab.view);
      this.layout();
    } else {
      this.win.contentView.removeChildView(tab.view);
    }
  }

  setChromeHeight(px: number): void {
    const h = Math.round(Math.min(Math.max(px, 40), 400));
    if (h === this.chromeHeight) return;
    this.chromeHeight = h;
    this.layout();
  }

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
    return tab.failedUrl ?? tab.view.webContents.getURL();
  }

  snapshot(): TabSnapshot[] {
    return this.all().map((tab) => {
      const wc = tab.view.webContents;
      const url = this.pageUrl(tab);
      let title = wc.getTitle();
      if (url === NEW_TAB_URL) title = '新标签页';
      else if (!title || title === url) title = displayUrl(url).replace(/^https?:\/\/(www\.)?/, '');
      return {
        id: tab.id,
        url: displayUrl(url),
        pageUrl: url,
        title,
        favicon: tab.favicon,
        loading: wc.isLoading(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        blocked: tab.blocked,
        hasLoginForm: tab.hasLoginForm,
      };
    });
  }

  private layout(): void {
    const tab = this.active();
    if (!tab || !this.visible) return;
    const [width, height] = this.win.getContentSize();
    const y = this.chromeHeight;
    tab.view.setBounds({ x: 0, y, width, height: Math.max(0, height - y) });
  }

  private wire(tab: Tab): void {
    const wc = tab.view.webContents;
    const update = () => this.hooks.changed();

    wc.on('page-title-updated', (_e, title) => {
      if (!wc.getURL().startsWith(ERROR_PAGE)) this.hooks.titleChanged(tab, title);
      update();
    });
    wc.on('did-start-loading', update);
    wc.on('did-stop-loading', update);
    // Reset the blocked counter when the navigation starts: the new page's first
    // requests can be blocked before 'did-navigate' reaches us.
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) tab.blocked = 0;
    });
    wc.on('did-navigate', (_e, url) => {
      tab.favicon = null;
      tab.hasLoginForm = false;
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
