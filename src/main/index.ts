import { app, Menu } from 'electron';
import { displayVersion } from '../shared/version';
import { BrowserApp } from './app';
import { registerInternalApi } from './internal-api';
import { buildMenu } from './menu';
import { registerInternalScheme } from './pages';
import { hardenApp, hardenBeforeReady } from './privacy';

hardenBeforeReady();
registerInternalScheme();

let browser: BrowserApp | null = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = browser?.win;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    hardenApp();
    app.setAboutPanelOptions({
      applicationName: 'MinBrowser',
      applicationVersion: displayVersion(app.getVersion()),
      version: '',
      copyright: '私密浏览器 · 数据只保存在你自己的电脑上',
    });
    browser = new BrowserApp();
    registerInternalApi(browser);
    Menu.setApplicationMenu(buildMenu(browser));
    browser.start();
  });

  // Defence in depth for any web contents, including ones we didn't create ourselves:
  // no <webview>, no popups unless a more specific handler (set later) allows them.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (ev) => ev.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

  // Quit when the window closes, on every platform: nothing should linger with data unlocked.
  app.on('window-all-closed', () => app.quit());

  // Flush encrypted data and wipe caches before exiting.
  let cleaned = false;
  app.on('before-quit', (e) => {
    if (cleaned || !browser) return;
    e.preventDefault();
    browser
      .shutdown()
      .catch((err) => console.error('shutdown failed', err))
      .finally(() => {
        cleaned = true;
        app.quit();
      });
  });
}
