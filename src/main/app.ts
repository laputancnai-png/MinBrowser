import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MenuItemConstructorOptions,
  nativeTheme,
  powerMonitor,
  session,
  Session,
} from 'electron';
import { accessSync, constants, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BarItem, CommandResult, Ipc, Phase, PopupData, Rect, SavePrompt, SetupDirResult, TabState, UiState } from '../shared/ipc';
import { generatePassword } from '../shared/password';
import { siteOf } from '../shared/privacy';
import { originOf } from '../shared/url';
import { AdBlocker } from './adblock';
import { BookmarkPopup } from './bookmark-popup';
import { SplitShield } from './split-shield';
import { DropZone, dropZone, Orientation, ratioAt, splitRects, zoneRect } from '../shared/split';
import { BAR_ID, BOOKMARKS_SCHEMA, BookmarkNode, BookmarkService } from './bookmarks';
import { ConfigStore, location } from './config';
import { DownloadManager } from './downloads';
import { HISTORY_SCHEMA, HistoryService } from './history';
import { serveInternalPages } from './pages';
import { PASSWORDS_SCHEMA, PasswordService } from './passwords';
import { hardenSession } from './privacy';
import { HistoryRecorder } from './recorder';
import { SESSION_SCHEMA, SessionService } from './session';
import { SITES_SCHEMA, SiteService } from './sites';
import { EncryptedStore } from './store';
import { Tab, TabManager } from './tabs';
import { MIN_PASSWORD_LENGTH, Vault } from './vault';

export const CONFIRM_PHRASE = '我明白忘记密码将无法恢复';
const ADBLOCK_MAX_AGE = 7 * 24 * 3600 * 1000;

interface Services {
  history: HistoryService;
  bookmarks: BookmarkService;
  passwords: PasswordService;
  sites: SiteService;
  session: SessionService;
  stores: EncryptedStore[];
}

interface PendingSave extends SavePrompt {
  password: string;
}

/**
 * Owns the window and the browser's lifecycle:
 *   setup  -> pick a data folder and a master password (first run)
 *   locked -> waiting for the master password; no pages visible
 *   unlocked -> browsing; encrypted stores are open
 */
export class BrowserApp {
  phase: Phase = 'setup';
  dataDir: string | null = null;
  win: BrowserWindow | null = null;
  config: ConfigStore | null = null;
  services: Services | null = null;
  tabs: TabManager | null = null;
  web: Session | null = null;
  adblock: AdBlocker | null = null;
  adblockStatus: { updating: boolean; error: string | null } = { updating: false, error: null };
  downloads: DownloadManager | null = null;
  popup: BookmarkPopup | null = null;
  shield: SplitShield | null = null;
  /** Transparent handle over the gap between split panes; it owns divider drags. */
  dividerHandle: SplitShield | null = null;
  /** What is being dragged over the page area, if anything. */
  private splitDrag: { kind: 'divider' } | { kind: 'tab'; tabId: number; zone: DropZone | null } | null = null;
  private vault: Vault | null = null;
  private recorder: HistoryRecorder;
  private pendingSave: PendingSave | null = null;
  private emitQueued = false;
  private quitting = false;
  private failedUnlocks = 0;

  constructor() {
    this.recorder = new HistoryRecorder(
      () => this.services?.history ?? null,
      () => this.config?.get().recordingPaused ?? true,
    );
    const dir = location.read();
    if (dir && Vault.exists(dir)) {
      this.dataDir = dir;
      this.config = new ConfigStore(dir);
      this.phase = 'locked';
    }
  }

  start(): void {
    // The UI renderer never loads remote content and needs no permissions.
    session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    ipcMain.handle(Ipc.Command, async (e, name: unknown, ...args: unknown[]): Promise<CommandResult> => {
      if (!this.win || e.sender !== this.win.webContents || typeof name !== 'string') {
        return { ok: false, error: 'forbidden' };
      }
      try {
        return { ok: true, value: await this.command(name, args) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
    this.watchForAutoLock();
    this.createWindow();
    this.registerPopupIpc();
    this.registerShieldIpc();
  }

  // ---------------------------------------------------------------- window

  private createWindow(): void {
    const isMac = process.platform === 'darwin';
    const icon = join(__dirname, '..', 'assets', 'icon.png');
    // Packaged apps get their icon from the bundle; in development set it ourselves.
    if (isMac && !app.isPackaged) app.dock?.setIcon(icon);
    const win = new BrowserWindow({
      icon,
      width: 1280,
      height: 820,
      minWidth: 560,
      minHeight: 360,
      title: 'MinBrowser',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#262624' : '#FAF9F5',
      titleBarStyle: isMac ? 'hiddenInset' : 'default',
      trafficLightPosition: isMac ? { x: 14, y: 13 } : undefined,
      autoHideMenuBar: !isMac,
      show: false,
      webPreferences: {
        preload: join(__dirname, '..', 'preload', 'ui.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    this.win = win;
    this.popup = new BookmarkPopup(win);
    this.shield = new SplitShield(win);
    this.dividerHandle = new SplitShield(win);
    const ui = win.webContents;
    ui.on('will-navigate', (e) => e.preventDefault());
    ui.setWindowOpenHandler(() => ({ action: 'deny' }));
    ui.once('did-finish-load', () => win.show());
    // Also after the UI reloads itself following a crash.
    ui.on('did-finish-load', () => this.emit());
    ui.on('render-process-gone', (_e, details) => {
      if (details.reason !== 'clean-exit' && !win.isDestroyed()) ui.reload();
    });
    // Save the open tabs while they still exist; after this the window and its pages are gone.
    win.on('close', () => this.saveSession());
    win.on('closed', () => {
      this.win = null;
    });
    win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  }

  // ---------------------------------------------------------------- state

  emit(): void {
    if (this.emitQueued) return;
    this.emitQueued = true;
    setImmediate(() => {
      this.emitQueued = false;
      if (this.win && !this.win.isDestroyed()) this.win.webContents.send(Ipc.State, this.state());
    });
  }

  private state(): UiState {
    const cfg = this.config?.get();
    const unlocked = this.phase === 'unlocked' && this.services && this.tabs;
    let tabs: TabState[] = [];
    let bar: BarItem[] = [];
    if (unlocked) {
      const { bookmarks, passwords, sites } = this.services!;
      tabs = this.tabs!.snapshot().map((t) => {
        const isWeb = /^https?:/.test(t.pageUrl);
        const site = isWeb ? siteOf(t.pageUrl) : null;
        const origin = isWeb ? originOf(t.pageUrl) : null;
        return {
          id: t.id,
          title: t.title,
          url: t.url,
          favicon: t.favicon,
          loading: t.loading,
          canGoBack: t.canGoBack,
          canGoForward: t.canGoForward,
          isWeb,
          bookmarked: isWeb && bookmarks.isBookmarked(t.pageUrl),
          blocked: t.blocked,
          shield: !cfg?.adblockEnabled ? 'off' : site && sites.adblockAllowed(site) ? 'paused' : 'on',
          showKey: isWeb && (t.hasLoginForm || (origin !== null && passwords.forOrigin(origin).length > 0)),
          splitPane: t.splitPane,
        };
      });
      bar = bookmarks.children(BAR_ID).map((b) => ({ id: b.id, type: b.type, title: b.title, url: b.url, description: b.description }));
    }
    const p = this.pendingSave;
    return {
      phase: this.phase,
      dataDir: this.dataDir,
      tabs,
      activeId: unlocked ? this.tabs!.activeTabId : null,
      recordingPaused: cfg?.recordingPaused ?? false,
      showBookmarksBar: cfg?.showBookmarksBar ?? true,
      bookmarksBar: bar,
      downloadsActive: this.downloads?.activeCount() ?? 0,
      savePrompt: p ? { tabId: p.tabId, origin: p.origin, username: p.username, update: p.update } : null,
      split: (() => {
        const s = unlocked ? this.tabs!.splitState : null;
        return s ? { orientation: s.orientation, ratio: s.ratio, panes: s.ids } : null;
      })(),
    };
  }

  // ---------------------------------------------------------------- UI commands

  private async command(name: string, args: unknown[]): Promise<unknown> {
    const str = (i: number) => {
      if (typeof args[i] !== 'string') throw new Error('bad argument');
      return args[i] as string;
    };
    const rect = (v: unknown): Rect => {
      const r = v as Rect;
      if (!r || [r.x, r.y, r.width, r.height].some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
        throw new Error('bad argument');
      }
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const orient = (v: unknown): Orientation => (v === 'vertical' ? 'vertical' : 'horizontal');
    const num = (i: number) => {
      if (typeof args[i] !== 'number' || !Number.isFinite(args[i])) throw new Error('bad argument');
      return args[i] as number;
    };

    switch (name) {
      case 'setup.chooseDir':
        return this.chooseDataDir();
      case 'setup.create':
        return this.createVault(str(0), str(1), str(2));
      case 'setup.useExisting':
        return this.useExisting(str(0));
      case 'unlock':
        return this.unlock(str(0));
      case 'switchDataDir':
        if (this.phase === 'unlocked') return;
        this.phase = 'setup';
        this.emit();
        return;
    }

    // Everything below needs an unlocked browser.
    const tabs = this.tabs;
    if (this.phase !== 'unlocked' || !tabs) throw new Error('浏览器已锁定');
    switch (name) {
      case 'newTab':
        return tabs.create();
      case 'closeTab':
        return tabs.close(num(0));
      case 'activateTab':
        return tabs.activate(num(0));
      case 'moveTab':
        return tabs.move(num(0), num(1));
      case 'navigate':
        return tabs.navigate(str(0));
      case 'back':
        return tabs.back();
      case 'forward':
        return tabs.forward();
      case 'reload':
        return tabs.reload();
      case 'stop':
        return tabs.stop();
      case 'chromeHeight':
        return tabs.setChromeHeight(num(0));
      case 'toggleBookmark':
        return this.toggleBookmark();
      case 'tabMenu':
        return this.tabMenu(num(0), num(1), num(2));
      case 'splitTab':
        return tabs.splitTab(args[0] === null ? null : num(0), orient(args[1]));
      case 'unsplit':
        return tabs.unsplit();
      case 'splitOrientation':
        return tabs.setSplitOrientation(orient(args[0]));
      case 'swapSplit':
        return tabs.swapSplit();
      case 'tabTearStart':
        return this.startSplitDrag({ kind: 'tab', tabId: num(0), zone: null });
      case 'splitPointer':
        return this.splitPointer(str(0), num(1), num(2));
      case 'closePopup':
        return this.popup?.close();
      case 'starClick':
        return this.starClick(rect(args[0]));
      case 'bookmarkDrop':
        return this.bookmarkDrop(
          str(0),
          args[1] === null ? null : num(1),
          args[2] === null ? null : num(2),
          rect(args[3]),
        );
      case 'toggleRecording':
        return this.setRecordingPaused(!this.config!.get().recordingPaused);
      case 'toggleShield':
        return this.toggleShield();
      case 'passwordMenu':
        return this.passwordMenu(num(0), num(1));
      case 'mainMenu':
        return this.mainMenu(num(0), num(1));
      case 'openBarItem':
        return this.openBookmark(num(0), args[1] === true);
      case 'folderMenu':
        return this.folderMenu(num(0), num(1), num(2));
      case 'savePrompt':
        return this.answerSavePrompt(str(0));
      case 'openPage':
        return this.openPage(str(0));
      case 'lock':
        return this.lock();
    }
    throw new Error(`unknown command ${name}`);
  }

  openPage(page: string): void {
    if (!['history', 'bookmarks', 'passwords', 'downloads', 'settings'].includes(page)) return;
    this.tabs?.openInternal(page);
  }

  // ---------------------------------------------------------------- setup & unlock

  private async chooseDataDir(): Promise<SetupDirResult | null> {
    const res = await dialog.showOpenDialog(this.win!, {
      title: '选择保存数据的文件夹',
      buttonLabel: '选择',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const dir = res.filePaths[0];
    try {
      accessSync(dir, constants.W_OK);
    } catch {
      throw new Error('无法写入这个文件夹，请选择其他位置');
    }
    return { dir, existing: Vault.exists(dir) };
  }

  private async createVault(dir: string, password: string, phrase: string): Promise<void> {
    if (phrase.trim() !== CONFIRM_PHRASE) throw new Error(`请输入“${CONFIRM_PHRASE}”以确认`);
    if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`主密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符`);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error('文件夹不存在');
    const vault = await Vault.create(dir, password);
    this.adoptDataDir(dir);
    await this.openSession(vault);
  }

  private useExisting(dir: string): void {
    if (!Vault.exists(dir)) throw new Error('这个文件夹里没有 MinBrowser 数据');
    this.adoptDataDir(dir);
    this.phase = 'locked';
    this.emit();
  }

  /** Point the app at a data folder. Switching folders after browsing started needs a restart. */
  private adoptDataDir(dir: string): void {
    if (this.web && this.dataDir !== dir) {
      location.write(dir);
      app.relaunch();
      app.exit(0);
      return;
    }
    location.write(dir);
    this.dataDir = dir;
    this.config = new ConfigStore(dir);
  }

  private async unlock(password: string): Promise<void> {
    if (this.phase !== 'locked' || !this.dataDir) return;
    let vault: Vault;
    try {
      vault = await Vault.unlock(this.dataDir, password);
    } catch (err) {
      // Slow down guessing a little beyond what Argon2 already costs.
      this.failedUnlocks++;
      await new Promise((r) => setTimeout(r, Math.min(this.failedUnlocks, 10) * 300));
      throw err;
    }
    this.failedUnlocks = 0;
    await this.openSession(vault);
  }

  private async openSession(vault: Vault): Promise<void> {
    const dir = this.dataDir!;
    const open = (name: string, schema: string) => EncryptedStore.open(dir, name, vault.key(`db:${name}`), schema);
    const stores: EncryptedStore[] = [];
    try {
      const history = open('history', HISTORY_SCHEMA);
      stores.push(history);
      const bookmarks = open('bookmarks', BOOKMARKS_SCHEMA);
      stores.push(bookmarks);
      const passwords = open('passwords', PASSWORDS_SCHEMA);
      stores.push(passwords);
      const sites = open('sites', SITES_SCHEMA);
      stores.push(sites);
      const session = open('session', SESSION_SCHEMA);
      stores.push(session);
      this.services = {
        history: new HistoryService(history),
        bookmarks: new BookmarkService(bookmarks),
        passwords: new PasswordService(passwords, vault.key('password-entries')),
        sites: new SiteService(sites),
        session: new SessionService(session),
        stores,
      };
    } catch (err) {
      for (const s of stores) s.close();
      vault.lock();
      throw new Error(`无法打开数据：${err instanceof Error ? err.message : err}`);
    }
    this.vault = vault;
    this.phase = 'unlocked';

    if (!this.web) this.startBrowsing(dir);
    else {
      this.tabs!.setVisible(true);
      // Internal pages showed nothing useful while locked; refresh them.
      for (const t of this.tabs!.all()) {
        const url = t.view.webContents.getURL();
        if (url.startsWith('min://') && !url.startsWith('min://newtab') && !url.startsWith('min://error')) t.view.webContents.reload();
      }
    }
    this.emit();
  }

  /** First unlock of this run: create the web session inside the data folder and open a tab. */
  private startBrowsing(dir: string): void {
    const chromiumDir = join(dir, 'chromium');
    mkdirSync(chromiumDir, { recursive: true });
    const web = session.fromPath(chromiumDir);
    this.web = web;
    this.adblock = new AdBlocker(join(dir, 'adblock.bin'));
    hardenSession(web, () => this.win, {
      shouldBlock: (url, type, pageUrl, wcId) => this.shouldBlock(url, type, pageUrl, wcId),
    });
    serveInternalPages(web);
    this.downloads = new DownloadManager(
      web,
      () => ({ dir: this.config?.get().downloadDir ?? null, ask: this.config?.get().askDownloadLocation ?? false }),
      () => this.emit(),
    );
    this.registerTabIpc();

    this.tabs = new TabManager(this.win!, this.win!.webContents, web, {
      changed: () => {
        this.emit();
        this.scheduleSessionSave();
      },
      navigated: (tab, url, transition) => {
        // The save prompt survives the redirect after logging in, but not the user going elsewhere.
        if (this.pendingSave?.tabId === tab.id && (transition === 'typed' || transition === 'bookmark')) {
          this.pendingSave = null;
        }
        this.recorder.navigated(tab.id, url, tab.view.webContents.getTitle(), transition, tab.openerId);
      },
      titleChanged: (tab, title) => this.recorder.titleChanged(tab.id, title),
      // Clicking into the page dismisses the bookmark bubble, like any popup.
      focused: () => this.popup?.close(),
      layoutChanged: () => this.updateDividerHandle(),
      closed: (tab) => {
        this.scheduleSessionSave();
        this.recorder.finish(tab.id);
        if (this.pendingSave?.tabId === tab.id) this.pendingSave = null;
      },
    });
    const saved = this.config?.get().restoreSession ? this.services?.session.load() : undefined;
    if (saved && saved.tabs.length > 0) this.tabs.restore(saved.tabs, saved.activeIndex, saved.split);
    else this.tabs.create();
    void this.maybeUpdateAdblock();
  }

  // ---------------------------------------------------------------- session restore

  private sessionTimer: NodeJS.Timeout | null = null;

  /** Save the open tabs shortly after things settle (pages fire many events while loading). */
  private scheduleSessionSave(): void {
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = setTimeout(() => this.saveSession(), 800);
  }

  /** Write the open tabs now. Safe to call any time; does nothing while locked. */
  saveSession(): void {
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = null;
    const session = this.services?.session;
    if (!session || !this.tabs || !this.win || this.win.isDestroyed()) return;
    try {
      if (this.config?.get().restoreSession) session.save(this.tabs.sessionTabs());
      else session.clear();
    } catch (err) {
      console.error('failed to save open tabs', err);
    }
  }

  lock(): void {
    if (this.phase !== 'unlocked' || !this.services) return;
    this.saveSession();
    this.popup?.close();
    this.endSplitDrag();
    this.dividerHandle?.hide();
    this.recorder.finishAll();
    this.pendingSave = null;
    this.closeServices();
    this.tabs?.setVisible(false);
    this.phase = 'locked';
    this.emit();
  }

  private closeServices(): void {
    if (!this.services) return;
    for (const s of this.services.stores) {
      try {
        s.close();
      } catch (err) {
        console.error('failed to close store', err);
      }
    }
    this.services.passwords.close();
    this.services = null;
    this.vault?.lock();
    this.vault = null;
  }

  private watchForAutoLock(): void {
    setInterval(() => {
      const minutes = this.config?.get().autoLockMinutes ?? 0;
      if (this.phase === 'unlocked' && minutes > 0 && powerMonitor.getSystemIdleTime() >= minutes * 60) this.lock();
    }, 15_000).unref();
    powerMonitor.on('lock-screen', () => this.lock());
    powerMonitor.on('suspend', () => this.lock());
  }

  async changePassword(current: string, next: string): Promise<void> {
    if (!this.vault) throw new Error('浏览器已锁定');
    await this.vault.changePassword(current, next);
  }

  /** Flush everything to disk and wipe what shouldn't outlive the session. */
  async shutdown(): Promise<void> {
    if (this.quitting) return;
    this.quitting = true;
    this.saveSession();
    this.recorder.finishAll();
    this.closeServices();
    if (this.web) {
      await this.web.clearCache().catch(() => undefined);
      if (this.config?.get().clearCookiesOnExit) await this.web.clearStorageData().catch(() => undefined);
      await this.web.cookies.flushStore().catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- recording

  setRecordingPaused(paused: boolean): void {
    if (paused) this.recorder.finishAll();
    this.config!.set({ recordingPaused: paused });
    this.emit();
  }

  // ---------------------------------------------------------------- bookmarks

  private activeWebUrl(): { url: string; title: string } | null {
    const tab = this.tabs?.active();
    if (!tab) return null;
    const url = this.tabs!.pageUrl(tab);
    if (!/^https?:/.test(url)) return null;
    return { url, title: tab.view.webContents.getTitle() };
  }

  /** Ctrl/Cmd+D: the UI knows where the star is, so ask it to open the bubble there. */
  toggleBookmark(): void {
    if (this.activeWebUrl()) this.win?.webContents.send(Ipc.StarRequest);
  }

  /** The folder new bookmarks go to: the one picked last time, if it still exists. */
  private bookmarkFolder(): number {
    const id = this.config?.get().lastBookmarkFolder;
    return id && this.services?.bookmarks.get(id)?.type === 'folder' ? id : BAR_ID;
  }

  /**
   * The star: bookmark the page right away (in the last-used folder) and open
   * the bubble to rename it or pick another folder. Already bookmarked: just
   * open the bubble to edit it.
   */
  starClick(anchor: Rect): void {
    const page = this.activeWebUrl();
    const bookmarks = this.services?.bookmarks;
    if (!page || !bookmarks) return;
    const existing = bookmarks.findByUrl(page.url);
    const id = existing?.id ?? bookmarks.addLink(this.bookmarkFolder(), page.title, page.url);
    this.emit();
    this.popup?.show(id, !existing, anchor);
  }

  /**
   * Something was dropped on the bookmarks bar: the page's site icon, or a link
   * dragged out of a page. `folderId` = dropped onto that folder; otherwise it
   * goes into the bar at `index` (null = at the end).
   */
  bookmarkDrop(url: string, folderId: number | null, index: number | null, anchor: Rect): void {
    const bookmarks = this.services?.bookmarks;
    if (!bookmarks || !/^https?:\/\//i.test(url)) return;
    const parent = folderId !== null && bookmarks.get(folderId)?.type === 'folder' ? folderId : BAR_ID;
    const page = this.activeWebUrl();
    let title = page && page.url === url ? page.title : '';
    if (!title) {
      try {
        title = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        title = url;
      }
    }
    const siblings = bookmarks.children(parent);
    const same = siblings.find((b) => b.url === url);
    const id = same?.id ?? bookmarks.addLink(parent, title, url);
    if (folderId === null && index !== null) {
      // `index` counts the bar as it looked during the drag; if this page was
      // already on it to the left of the drop point, its own slot goes away.
      const current = same ? siblings.indexOf(same) : -1;
      bookmarks.move(id, parent, current !== -1 && current < index ? index - 1 : index);
    }
    this.config?.set({ lastBookmarkFolder: parent });
    this.emit();
    this.popup?.show(id, !same, anchor);
  }

  // ---------------------------------------------------------------- split view

  /** Right-click on a tab. */
  private tabMenu(id: number, x: number, y: number): void {
    const tabs = this.tabs;
    if (!tabs?.get(id)) return;
    const split = tabs.splitState;
    const inSplit = !!split?.ids.includes(id);
    const items: MenuItemConstructorOptions[] = [];
    if (!inSplit) {
      items.push(
        { label: '在右侧分屏打开', click: () => tabs.splitTab(id, 'horizontal') },
        { label: '在下方分屏打开', click: () => tabs.splitTab(id, 'vertical') },
      );
    }
    if (split) {
      if (items.length) items.push({ type: 'separator' });
      items.push(
        split.orientation === 'horizontal'
          ? { label: '改为上下分屏', click: () => tabs.setSplitOrientation('vertical') }
          : { label: '改为左右分屏', click: () => tabs.setSplitOrientation('horizontal') },
        { label: '交换两侧', click: () => tabs.swapSplit() },
        { label: '退出分屏', click: () => tabs.unsplit() },
      );
    }
    items.push({ type: 'separator' }, { label: '关闭标签页', click: () => tabs.close(id) });
    Menu.buildFromTemplate(items).popup({ window: this.win!, x, y });
  }

  /** Dragging a tab out of the strip: show the drop layer over the pages. */
  private startSplitDrag(drag: NonNullable<BrowserApp['splitDrag']>): void {
    const tabs = this.tabs;
    if (!tabs || !this.shield) return;
    this.splitDrag = drag;
    this.popup?.close();
    this.shield.show('tabdrop', tabs.splitState?.orientation ?? 'horizontal', tabs.contentArea());
  }

  /**
   * Keep the divider handle over the gap between the two panes and above the
   * pages. During a divider drag it covers the whole page area instead, so the
   * pointer never leaves it.
   */
  private updateDividerHandle(): void {
    const handle = this.dividerHandle;
    const tabs = this.tabs;
    const split = this.phase === 'unlocked' ? tabs?.splitState : null;
    if (!handle) return;
    if (!split || !tabs) {
      handle.hide();
      return;
    }
    const area = tabs.contentArea();
    const rect = this.splitDrag?.kind === 'divider' ? area : splitRects(area, split.orientation, split.ratio).divider;
    if (!handle.isShown || this.handleOrientation !== split.orientation) {
      handle.show('handle', split.orientation, rect);
      this.handleOrientation = split.orientation;
    } else {
      handle.setBounds(rect);
    }
    handle.raise();
  }

  private handleOrientation: Orientation | null = null;

  /** Pointer events during a split drag, from the UI or from the drag layer (window coordinates). */
  private splitPointer(kind: string, x: number, y: number): void {
    const drag = this.splitDrag;
    const tabs = this.tabs;
    if (!drag || !tabs) return;
    const area = tabs.contentArea();
    if (kind === 'cancel') return this.endSplitDrag();
    if (drag.kind === 'divider') {
      const split = tabs.splitState;
      if (split) tabs.setSplitRatio(ratioAt(area, split.orientation, x, y));
      if (kind === 'up') this.endSplitDrag();
      return;
    }
    const zone = dropZone(area, x, y);
    if (zone !== drag.zone) {
      drag.zone = zone;
      this.shield?.setZone(zone ? zoneRect(area, zone) : null);
    }
    if (kind === 'up') {
      this.endSplitDrag();
      if (zone && tabs.get(drag.tabId)) tabs.splitTab(drag.tabId, zone === 'right' ? 'horizontal' : 'vertical');
    }
  }

  private endSplitDrag(): void {
    this.splitDrag = null;
    this.shield?.hide();
    this.updateDividerHandle();
    this.emit();
  }

  private registerShieldIpc(): void {
    ipcMain.on(Ipc.ShieldEvent, (e, kind: unknown, sx: unknown, sy: unknown) => {
      if (typeof kind !== 'string' || typeof sx !== 'number' || typeof sy !== 'number' || !this.win) return;
      // The layers report screen coordinates; turn them into window coordinates.
      const content = this.win.getContentBounds();
      const x = sx - content.x;
      const y = sy - content.y;
      if (this.dividerHandle?.owns(e.sender)) {
        if (kind === 'down' && this.tabs?.splitState) {
          this.splitDrag = { kind: 'divider' };
          this.popup?.close();
          this.updateDividerHandle(); // grow to cover the pages for the drag
          return;
        }
        if (this.splitDrag?.kind === 'divider') this.splitPointer(kind, x, y);
        return;
      }
      if (this.shield?.owns(e.sender) && kind !== 'down') this.splitPointer(kind, x, y);
    });
  }

  private registerPopupIpc(): void {
    ipcMain.handle(Ipc.Popup, (e, name: unknown, ...args: unknown[]) => {
      const popup = this.popup;
      const bookmarks = this.services?.bookmarks;
      if (!popup?.owns(e.sender) || popup.bookmarkId === null || !bookmarks) throw new Error('forbidden');
      if (name === 'fit') {
        if (typeof args[0] === 'number' && Number.isFinite(args[0])) popup.fit(args[0]);
        return null;
      }
      const id = popup.bookmarkId;
      const b = bookmarks.get(id);
      if (!b) {
        popup.close();
        return null;
      }
      switch (name) {
        case 'data': {
          const data: PopupData = {
            isNew: popup.isNew,
            bookmark: { id, title: b.title, url: b.url ?? '', description: b.description, parentId: b.parent_id ?? BAR_ID },
            folders: bookmarks.folderList(),
          };
          return data;
        }
        case 'save': {
          const [title, folder, description] = args;
          if (typeof title !== 'string' || typeof folder !== 'number' || typeof description !== 'string') throw new Error('bad argument');
          if (title.length > 500 || description.length > 1000) throw new Error('bad argument');
          bookmarks.update(id, { title, description });
          if (folder !== b.parent_id && bookmarks.get(folder)?.type === 'folder') bookmarks.move(id, folder, 1_000_000);
          this.config?.set({ lastBookmarkFolder: folder });
          break;
        }
        case 'remove':
          bookmarks.remove(id);
          break;
        case 'manage':
          this.openPage('bookmarks');
          break;
        case 'close':
          break;
        default:
          throw new Error('unknown command');
      }
      popup.close();
      this.emit();
      return null;
    });
  }

  openBookmark(id: number, newTab: boolean): void {
    const b = this.services?.bookmarks.get(id);
    if (!b || b.type !== 'link' || !b.url) return;
    this.openUrl(b.url, newTab, 'bookmark');
  }

  openUrl(url: string, newTab: boolean, transition: 'bookmark' | 'typed' | 'link'): void {
    if (!/^https?:/.test(url) || !this.tabs) return;
    if (newTab) this.tabs.create(url, { transition });
    else this.tabs.load(url, transition);
  }

  private folderMenu(id: number, x: number, y: number): void {
    const tree = this.services?.bookmarks.tree();
    if (!tree) return;
    const find = (nodes: BookmarkNode[]): BookmarkNode | undefined => {
      for (const n of nodes) {
        if (n.id === id) return n;
        const hit = n.children && find(n.children);
        if (hit) return hit;
      }
      return undefined;
    };
    const folder = find(tree);
    if (!folder?.children) return;
    const build = (nodes: BookmarkNode[]): MenuItemConstructorOptions[] =>
      nodes.length === 0
        ? [{ label: '（空）', enabled: false }]
        : nodes.slice(0, 200).map((n) =>
            n.type === 'folder'
              ? { label: n.title, submenu: build(n.children ?? []) }
              : { ...menuLabel(n.title, n.description), click: () => this.openUrl(n.url!, false, 'bookmark') },
          );
    Menu.buildFromTemplate(build(folder.children)).popup({ window: this.win!, x, y });
  }

  // ---------------------------------------------------------------- ad blocking

  private shouldBlock(url: string, type: string, pageUrl: string, wcId: number | undefined): boolean {
    if (!this.adblock || !this.config?.get().adblockEnabled) return false;
    const site = siteOf(pageUrl);
    if (site && this.services?.sites.adblockAllowed(site)) return false;
    if (!this.adblock.shouldBlock(url, type, pageUrl)) return false;
    const tab = wcId !== undefined ? this.tabs?.byWebContentsId(wcId) : undefined;
    if (tab) {
      tab.blocked++;
      this.emit();
    }
    return true;
  }

  private toggleShield(): void {
    const page = this.activeWebUrl();
    const site = page && siteOf(page.url);
    const sites = this.services?.sites;
    if (!site || !sites) return;
    sites.setAdblockAllowed(site, !sites.adblockAllowed(site));
    this.tabs?.reload();
    this.emit();
  }

  async maybeUpdateAdblock(force = false): Promise<void> {
    const cfg = this.config?.get();
    if (!cfg || !this.adblock || !this.web || this.adblockStatus.updating) return;
    if (!force && (!cfg.adblockEnabled || (cfg.adblockUpdatedAt && Date.now() - cfg.adblockUpdatedAt < ADBLOCK_MAX_AGE))) return;
    this.adblockStatus = { updating: true, error: null };
    const web = this.web;
    try {
      await this.adblock.update(async (url) => {
        const res = await web.fetch(url, { credentials: 'omit' });
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        return res.text();
      });
      this.config?.set({ adblockUpdatedAt: Date.now() });
      this.adblockStatus = { updating: false, error: null };
    } catch (err) {
      this.adblockStatus = { updating: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---------------------------------------------------------------- passwords

  private registerTabIpc(): void {
    const tabFor = (e: Electron.IpcMainEvent) => {
      // Only the top frame of one of our tabs, on a web page, may talk to us.
      const frame = e.senderFrame;
      if (!frame || frame.parent !== null) return null;
      const tab = this.tabs?.byWebContents(e.sender);
      const origin = originOf(frame.url);
      return tab && origin ? { tab, origin } : null;
    };

    ipcMain.on(Ipc.PwForms, (e, step: unknown) => {
      const t = tabFor(e);
      if (!t || (step !== 'password' && step !== 'username' && step !== null) || t.tab.loginStep === step) return;
      t.tab.loginStep = step;
      t.tab.hasLoginForm = step !== null;
      if (step) this.autofill(t.tab, t.origin, step);
      this.emit();
    });

    // First step of a multi-step login: keep the username for the password step.
    ipcMain.on(Ipc.PwUsername, (e, username: unknown) => {
      const t = tabFor(e);
      const site = t && siteOf(t.origin);
      if (!t || !site || typeof username !== 'string' || !username || username.length > 512) return;
      t.tab.pendingUsername = { site, username, at: Date.now() };
    });

    ipcMain.on(Ipc.PwSubmit, (e, data: unknown) => {
      const t = tabFor(e);
      const passwords = this.services?.passwords;
      if (!t || !passwords || this.phase !== 'unlocked') return;
      const { username: u, password } = (data ?? {}) as { username?: unknown; password?: unknown };
      if (typeof u !== 'string' || typeof password !== 'string') return;
      let username = u;
      if (!password || password.length > 1024 || username.length > 512) return;
      if (passwords.isNeverSave(t.origin)) return;
      // Password-only step: the username was entered on the step before.
      if (!username) username = this.recentUsername(t.tab, t.origin) ?? '';
      const logins = passwords.forOrigin(t.origin);
      const existing = logins.find((l) => BrowserApp.sameUser(l.username, username));
      if (existing && passwords.password(existing.id) === password) {
        passwords.markUsed(existing.id);
        return;
      }
      // The same password saved earlier without a username: it's this login, so
      // just give it its username instead of asking to save a second copy.
      const unnamed = username && !existing ? logins.find((l) => !l.username && passwords.password(l.id) === password) : undefined;
      if (unnamed) {
        passwords.update(unnamed.id, { username });
        passwords.markUsed(unnamed.id);
        return;
      }
      // Updating keeps the username as it was saved (it may differ in case from what was typed).
      this.pendingSave = { tabId: t.tab.id, origin: t.origin, username: existing?.username ?? username, password, update: !!existing };
      this.emit();
    });
  }

  private answerSavePrompt(action: string): void {
    const p = this.pendingSave;
    const passwords = this.services?.passwords;
    this.pendingSave = null;
    if (p && passwords) {
      if (action === 'save') passwords.save(p.origin, p.username, p.password);
      else if (action === 'never') passwords.setNeverSave(p.origin, true);
    }
    this.emit();
  }

  private passwordMenu(x: number, y: number): void {
    const tab = this.tabs?.active();
    const passwords = this.services?.passwords;
    if (!tab || !passwords) return;
    const origin = originOf(this.tabs!.pageUrl(tab));
    if (!origin) return;
    const logins = passwords.forOrigin(origin);
    const items: MenuItemConstructorOptions[] = logins.map((c) => ({
      label: `填充 ${c.username || '（无用户名）'}`,
      click: () => this.fillLogin(tab.id, c.id),
    }));
    if (logins.length === 0) items.push({ label: '这个网站还没有保存的密码', enabled: false });
    items.push(
      { type: 'separator' },
      { label: '生成强密码并填入', click: () => this.fillGenerated(tab.id) },
      { label: '管理密码…', click: () => this.openPage('passwords') },
    );
    Menu.buildFromTemplate(items).popup({ window: this.win!, x, y });
  }

  private fillLogin(tabId: number, credentialId: number): void {
    const tab = this.tabs?.get(tabId);
    const passwords = this.services?.passwords;
    const cred = passwords?.get(credentialId);
    if (!tab || !passwords || !cred) return;
    // Re-check at fill time: the page may have navigated since the menu opened.
    if (originOf(tab.view.webContents.getURL()) !== cred.origin) return;
    tab.view.webContents.send(Ipc.PwFill, { username: cred.username, password: passwords.password(cred.id) });
    passwords.markUsed(cred.id);
  }

  /** Usernames are compared like most sites do: ignoring case and surrounding spaces. */
  private static sameUser(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }

  /** The username typed on a previous login step of this site in this tab, if recent. */
  private recentUsername(tab: Tab, origin: string): string | null {
    const p = tab.pendingUsername;
    if (!p || p.site !== siteOf(origin) || Date.now() - p.at > 15 * 60_000) return null;
    return p.username;
  }

  /**
   * Fill a saved login when a login form appears, like other browsers do.
   * Username step: only the username of the most recently used login.
   * Password step: the login whose username was entered on the step before,
   * otherwise the most recently used one. Only on https (or this computer),
   * each step once per page, and the page agent only fills empty fields.
   */
  private autofill(tab: Tab, origin: string, step: 'password' | 'username'): void {
    const passwords = this.services?.passwords;
    if (!passwords || this.phase !== 'unlocked' || tab.autofilled.has(step)) return;
    if (!this.config?.get().autofillPasswords) return;
    const url = new URL(origin);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol !== 'https:' && !local) return;
    const logins = passwords.forOrigin(origin);
    if (logins.length === 0) return;
    tab.autofilled.add(step);
    if (step === 'username') {
      const named = logins.find((l) => l.username);
      if (named) tab.view.webContents.send(Ipc.PwFill, { username: named.username, auto: true });
      return;
    }
    // A username typed on the step before decides the login. If nothing is saved
    // for that username, fill nothing rather than someone else's password, except
    // a single login saved without a username (older saves of multi-step logins).
    const typed = this.recentUsername(tab, origin);
    const unnamed = logins.filter((l) => !l.username);
    const login =
      typed === null
        ? logins[0]
        : (logins.find((l) => BrowserApp.sameUser(l.username, typed)) ?? (unnamed.length === 1 ? unnamed[0] : undefined));
    if (!login) return;
    tab.view.webContents.send(Ipc.PwFill, { username: login.username, password: passwords.password(login.id), auto: true });
  }

  private fillGenerated(tabId: number): void {
    const tab = this.tabs?.get(tabId);
    if (tab) tab.view.webContents.send(Ipc.PwFillNew, generatePassword(20));
  }

  // ---------------------------------------------------------------- main menu

  private mainMenu(x: number, y: number): void {
    const cfg = this.config!.get();
    const template: MenuItemConstructorOptions[] = [
      { label: '新建标签页', click: () => this.tabs?.create() },
      { type: 'separator' },
      { label: '历史记录', click: () => this.openPage('history') },
      { label: '收藏夹', click: () => this.openPage('bookmarks') },
      { label: '密码', click: () => this.openPage('passwords') },
      { label: '下载', click: () => this.openPage('downloads') },
      { type: 'separator' },
      {
        label: '显示收藏夹栏',
        type: 'checkbox',
        checked: cfg.showBookmarksBar,
        click: () => {
          this.config!.set({ showBookmarksBar: !cfg.showBookmarksBar });
          this.emit();
        },
      },
      { label: '暂停记录浏览历史', type: 'checkbox', checked: cfg.recordingPaused, click: () => this.setRecordingPaused(!cfg.recordingPaused) },
      { type: 'separator' },
      { label: '设置', click: () => this.openPage('settings') },
      { label: '立即锁定', click: () => this.lock() },
    ];
    Menu.buildFromTemplate(template).popup({ window: this.win!, x, y });
  }

  vaultUnlocked(): boolean {
    return this.phase === 'unlocked' && !!this.vault?.unlocked;
  }
}

/**
 * A bookmark in a native menu. macOS can show the description as a second
 * line; elsewhere it follows the title.
 */
function menuLabel(title: string, description: string): { label: string; sublabel?: string } {
  const t = title.length > 60 ? `${title.slice(0, 59)}…` : title;
  if (!description) return { label: t };
  if (process.platform === 'darwin') return { label: t, sublabel: description };
  return { label: `${t}  —  ${description.length > 40 ? `${description.slice(0, 39)}…` : description}` };
}
