import { app, Menu } from 'electron';
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
    browser = new BrowserApp();
    registerInternalApi(browser);
    Menu.setApplicationMenu(buildMenu(browser));
    browser.start();
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
