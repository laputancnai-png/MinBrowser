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
import { BarItem, CommandResult, Ipc, Phase, SavePrompt, SetupDirResult, TabState, UiState } from '../shared/ipc';
import { generatePassword } from '../shared/password';
import { siteOf } from '../shared/privacy';
import { originOf } from '../shared/url';
import { AdBlocker } from './adblock';
import { BAR_ID, BOOKMARKS_SCHEMA, BookmarkNode, BookmarkService } from './bookmarks';
import { ConfigStore, location } from './config';
import { DownloadManager } from './downloads';
import { HISTORY_SCHEMA, HistoryService } from './history';
import { serveInternalPages } from './pages';
import { PASSWORDS_SCHEMA, PasswordService } from './passwords';
import { hardenSession } from './privacy';
import { HistoryRecorder } from './recorder';
import { SITES_SCHEMA, SiteService } from './sites';
import { EncryptedStore } from './store';
import { TabManager } from './tabs';
import { MIN_PASSWORD_LENGTH, Vault } from './vault';

export const CONFIRM_PHRASE = '我明白忘记密码将无法恢复';
const ADBLOCK_MAX_AGE = 7 * 24 * 3600 * 1000;

interface Services {
  history: HistoryService;
  bookmarks: BookmarkService;
  passwords: PasswordService;
  sites: SiteService;
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
  }

  // ---------------------------------------------------------------- window

  private createWindow(): void {
    const isMac = process.platform === 'darwin';
    const win = new BrowserWindow({
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
    const ui = win.webContents;
    ui.on('will-navigate', (e) => e.preventDefault());
    ui.setWindowOpenHandler(() => ({ action: 'deny' }));
    ui.once('did-finish-load', () => {
      this.emit();
      win.show();
    });
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
        };
      });
      bar = bookmarks.children(BAR_ID).map((b) => ({ id: b.id, type: b.type, title: b.title, url: b.url }));
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
    };
  }

  // ---------------------------------------------------------------- UI commands

  private async command(name: string, args: unknown[]): Promise<unknown> {
    const str = (i: number) => {
      if (typeof args[i] !== 'string') throw new Error('bad argument');
      return args[i] as string;
    };
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
      this.services = {
        history: new HistoryService(history),
        bookmarks: new BookmarkService(bookmarks),
        passwords: new PasswordService(passwords, vault.key('password-entries')),
        sites: new SiteService(sites),
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
      changed: () => this.emit(),
      navigated: (tab, url, transition) => {
        // The save prompt survives the redirect after logging in, but not the user going elsewhere.
        if (this.pendingSave?.tabId === tab.id && (transition === 'typed' || transition === 'bookmark')) {
          this.pendingSave = null;
        }
        this.recorder.navigated(tab.id, url, tab.view.webContents.getTitle(), transition, tab.openerId);
      },
      titleChanged: (tab, title) => this.recorder.titleChanged(tab.id, title),
      closed: (tab) => {
        this.recorder.finish(tab.id);
        if (this.pendingSave?.tabId === tab.id) this.pendingSave = null;
      },
    });
    this.tabs.create();
    void this.maybeUpdateAdblock();
  }

  lock(): void {
    if (this.phase !== 'unlocked' || !this.services) return;
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

  toggleBookmark(): void {
    const page = this.activeWebUrl();
    const bookmarks = this.services?.bookmarks;
    if (!page || !bookmarks) return;
    if (bookmarks.isBookmarked(page.url)) bookmarks.removeUrl(page.url);
    else bookmarks.addLink(BAR_ID, page.title, page.url);
    this.emit();
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
              : { label: n.title.slice(0, 80), click: () => this.openUrl(n.url!, false, 'bookmark') },
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

    ipcMain.on(Ipc.PwForms, (e, has: unknown) => {
      const t = tabFor(e);
      if (!t || typeof has !== 'boolean' || t.tab.hasLoginForm === has) return;
      t.tab.hasLoginForm = has;
      this.emit();
    });

    ipcMain.on(Ipc.PwSubmit, (e, data: unknown) => {
      const t = tabFor(e);
      const passwords = this.services?.passwords;
      if (!t || !passwords || this.phase !== 'unlocked') return;
      const { username, password } = (data ?? {}) as { username?: unknown; password?: unknown };
      if (typeof username !== 'string' || typeof password !== 'string') return;
      if (!password || password.length > 1024 || username.length > 512) return;
      if (passwords.isNeverSave(t.origin)) return;
      const existing = passwords.find(t.origin, username);
      if (existing && passwords.password(existing.id) === password) {
        passwords.markUsed(existing.id);
        return;
      }
      this.pendingSave = { tabId: t.tab.id, origin: t.origin, username, password, update: !!existing };
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
