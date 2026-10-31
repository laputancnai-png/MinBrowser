import { BrowserWindow, Session, WebContents, WebContentsView } from 'electron';
import { Ipc, TabState, TabsState } from '../shared/ipc';
import { NEW_TAB_URL, displayUrl, isInternalUrl, resolveInput } from '../shared/url';

/** Height of the tab strip + toolbar drawn by the UI renderer. Must match styles.css. */
export const CHROME_HEIGHT = 84;

const ERROR_PAGE = 'min://error/';

interface Tab {
  id: number;
  view: WebContentsView;
  favicon: string | null;
  /** The address that failed to load while the error page is showing. */
  failedUrl: string | null;
}

export class TabManager {
  private tabs = new Map<number, Tab>();
  private order: number[] = [];
  private activeId: number | null = null;
  private nextId = 1;

  constructor(
    private readonly win: BrowserWindow,
    private readonly ui: WebContents,
    private readonly session: Session,
  ) {
    win.on('resize', () => this.layout());
  }

  create(url: string = NEW_TAB_URL, activate = true): number {
    const id = this.nextId++;
    const view = new WebContentsView({
      webPreferences: {
        session: this.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    });
    const tab: Tab = { id, view, favicon: null, failedUrl: null };
    this.tabs.set(id, tab);

    const index = this.activeId === null ? -1 : this.order.indexOf(this.activeId);
    this.order.splice(index + 1, 0, id);

    this.wire(tab);
    view.webContents.loadURL(url);
    if (activate) this.activate(id);
    else this.emit();
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
    tab.view.webContents.close();

    if (this.order.length === 0) {
      this.activeId = null;
      this.create();
      return;
    }
    if (this.activeId === id) {
      this.activate(this.order[Math.min(index, this.order.length - 1)]);
    } else {
      this.emit();
    }
  }

  closeActive(): void {
    if (this.activeId !== null) this.close(this.activeId);
  }

  activate(id: number): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const prev = this.activeId !== null ? this.tabs.get(this.activeId) : undefined;
    if (prev && prev !== tab) this.win.contentView.removeChildView(prev.view);
    this.activeId = id;
    this.win.contentView.addChildView(tab.view);
    this.layout();
    if (!isInternalUrl(tab.view.webContents.getURL())) tab.view.webContents.focus();
    this.emit();
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

  navigate(input: string): void {
    const url = resolveInput(input);
    const tab = this.active();
    if (!url || !tab) return;
    tab.failedUrl = null;
    tab.view.webContents.loadURL(url);
    tab.view.webContents.focus();
  }

  back(): void {
    const h = this.active()?.view.webContents.navigationHistory;
    if (h?.canGoBack()) h.goBack();
  }

  forward(): void {
    const h = this.active()?.view.webContents.navigationHistory;
    if (h?.canGoForward()) h.goForward();
  }

  reload(): void {
    const tab = this.active();
    if (!tab) return;
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

  private active(): Tab | undefined {
    return this.activeId === null ? undefined : this.tabs.get(this.activeId);
  }

  private layout(): void {
    const tab = this.active();
    if (!tab) return;
    const [width, height] = this.win.getContentSize();
    tab.view.setBounds({ x: 0, y: CHROME_HEIGHT, width, height: Math.max(0, height - CHROME_HEIGHT) });
  }

  private wire(tab: Tab): void {
    const wc = tab.view.webContents;
    const update = () => this.emit();

    wc.on('page-title-updated', update);
    wc.on('did-start-loading', update);
    wc.on('did-stop-loading', update);
    wc.on('did-navigate', (_e, url) => {
      tab.favicon = null;
      if (!url.startsWith(ERROR_PAGE)) tab.failedUrl = null;
      update();
    });
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      // -3 is ERR_ABORTED: the user stopped or navigated away, not a real failure.
      if (!isMainFrame || code === -3 || url.startsWith(ERROR_PAGE)) return;
      tab.failedUrl = url;
      const query = new URLSearchParams({ code: description, url });
      wc.loadURL(`${ERROR_PAGE}?${query}`);
    });
    wc.on('did-navigate-in-page', update);
    wc.on('page-favicon-updated', async (_e, favicons) => {
      const pageUrl = wc.getURL();
      const icon = await this.loadFavicon(favicons);
      if (wc.isDestroyed() || wc.getURL() !== pageUrl) return;
      tab.favicon = icon;
      update();
    });

    // Popups and target=_blank links open as a new tab next to this one.
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) this.create(url);
      return { action: 'deny' };
    });

    // Web pages may not navigate into internal min:// pages; only the address bar can.
    wc.on('will-navigate', (event, url) => {
      if (isInternalUrl(url) && !isInternalUrl(wc.getURL())) event.preventDefault();
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

  private emit(): void {
    const state: TabsState = {
      activeId: this.activeId,
      tabs: this.order.map((id) => this.snapshot(this.tabs.get(id)!)),
    };
    this.ui.send(Ipc.State, state);
  }

  private snapshot(tab: Tab): TabState {
    const wc = tab.view.webContents;
    const url = tab.failedUrl ?? wc.getURL();
    let title = wc.getTitle();
    if (url === NEW_TAB_URL) title = '新标签页';
    else if (!title || title === url) title = displayUrl(url).replace(/^https?:\/\/(www\.)?/, '');
    return {
      id: tab.id,
      url: displayUrl(url),
      title,
      favicon: tab.favicon,
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    };
  }
}
