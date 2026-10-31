import { app, BrowserWindow, ipcMain, Menu, nativeTheme, session } from 'electron';
import { join } from 'node:path';
import { Ipc } from '../shared/ipc';
import { buildMenu } from './menu';
import { registerInternalScheme, serveInternalPages } from './pages';
import { hardenApp, hardenBeforeReady, hardenSession } from './privacy';
import { TabManager } from './tabs';

/** All web content lives in this partition, kept apart from the browser's own UI. */
const WEB_PARTITION = 'persist:web';

let win: BrowserWindow | null = null;
let tabs: TabManager | null = null;

hardenBeforeReady();
registerInternalScheme();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(start);
}

function start(): void {
  hardenApp();
  const web = session.fromPartition(WEB_PARTITION);
  hardenSession(web, () => win);
  serveInternalPages(web);

  // The UI renderer never loads remote content.
  session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));

  Menu.setApplicationMenu(buildMenu(() => tabs));
  registerIpc();
  createWindow(web);
}

function createWindow(web: Electron.Session): void {
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 480,
    minHeight: 320,
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

  const ui = win.webContents;
  ui.on('will-navigate', (e) => e.preventDefault());
  ui.setWindowOpenHandler(() => ({ action: 'deny' }));

  tabs = new TabManager(win, ui, web);
  ui.once('did-finish-load', () => {
    tabs?.create();
    win?.show();
  });
  win.on('closed', () => {
    win = null;
    tabs = null;
  });

  win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
}

function registerIpc(): void {
  // Only the browser UI may drive tabs; web pages have no preload and can't reach these.
  const fromUi = (e: Electron.IpcMainEvent) => win !== null && e.sender === win.webContents;
  const on = <A extends unknown[]>(channel: string, fn: (t: TabManager, ...args: A) => void) =>
    ipcMain.on(channel, (e, ...args) => {
      if (fromUi(e) && tabs) fn(tabs, ...(args as A));
    });

  on(Ipc.NewTab, (t) => t.create());
  on<[number]>(Ipc.CloseTab, (t, id) => typeof id === 'number' && t.close(id));
  on<[number]>(Ipc.ActivateTab, (t, id) => typeof id === 'number' && t.activate(id));
  on<[string]>(Ipc.Navigate, (t, input) => typeof input === 'string' && t.navigate(input));
  on(Ipc.Back, (t) => t.back());
  on(Ipc.Forward, (t) => t.forward());
  on(Ipc.Reload, (t) => t.reload());
  on(Ipc.Stop, (t) => t.stop());
}

// Quit when the window closes, on every platform: nothing should linger with data unlocked.
app.on('window-all-closed', () => app.quit());
