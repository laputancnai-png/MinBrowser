import { app, dialog, BrowserWindow, Session } from 'electron';
import { cleanUserAgent, isThirdParty } from '../shared/privacy';

/** Permissions granted without asking; they can't be used to track or spy. */
const ALWAYS_ALLOW = new Set(['fullscreen', 'clipboard-sanitized-write']);

/** Permissions we ask the user about. Everything else is denied. */
const ASK: Record<string, string> = {
  media: '使用摄像头或麦克风',
  geolocation: '获取你的位置',
  notifications: '向你发送通知',
  midi: '访问 MIDI 设备',
  midiSysex: '访问 MIDI 设备',
  pointerLock: '锁定鼠标指针',
  'clipboard-read': '读取剪贴板',
  'display-capture': '录制你的屏幕',
  'idle-detection': '检测你是否在使用电脑',
  'window-management': '管理窗口',
};

export const DOH_SERVERS = ['https://dns.quad9.net/dns-query', 'https://cloudflare-dns.com/dns-query'];

/** Must run before app "ready". */
export function hardenBeforeReady(): void {
  app.commandLine.appendSwitch('disable-features', 'AutofillServerCommunication,MediaRouter,OptimizationHints');
  app.userAgentFallback = cleanUserAgent(app.userAgentFallback);
}

/** Process-wide settings that need a ready app. */
export function hardenApp(): void {
  app.configureHostResolver({ secureDnsMode: 'secure', secureDnsServers: DOH_SERVERS });
}

export interface RequestBlocker {
  /** Return true to cancel a sub-resource request. */
  shouldBlock(url: string, resourceType: string, pageUrl: string, webContentsId: number | undefined): boolean;
}

export function hardenSession(session: Session, getWindow: () => BrowserWindow | null, blocker?: RequestBlocker): void {
  session.setUserAgent(cleanUserAgent(session.getUserAgent()));

  // Spellcheck dictionaries are downloaded from Google's CDN on Linux; turn it all off.
  session.setSpellCheckerEnabled(false);
  session.setSpellCheckerDictionaryDownloadURL('https://localhost.invalid/');

  blockThirdPartyCookies(session);
  if (blocker) blockRequests(session, blocker);
  handlePermissions(session, getWindow);
}

function blockRequests(session: Session, blocker: RequestBlocker): void {
  session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    if (details.resourceType === 'mainFrame') return callback({});
    const page = details.webContents?.getURL();
    if (!page) return callback({});
    callback({ cancel: blocker.shouldBlock(details.url, details.resourceType, page, details.webContents?.id) });
  });
}

function topLevelUrl(details: { resourceType: string; url: string; webContents?: Electron.WebContents }): string | null {
  if (details.resourceType === 'mainFrame') return details.url;
  return details.webContents?.getURL() || null;
}

function blockThirdPartyCookies(session: Session): void {
  const filter = { urls: ['http://*/*', 'https://*/*'] };

  session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const top = topLevelUrl(details);
    if (top && isThirdParty(details.url, top)) {
      const headers = { ...details.requestHeaders };
      for (const key of Object.keys(headers)) if (key.toLowerCase() === 'cookie') delete headers[key];
      callback({ requestHeaders: headers });
      return;
    }
    callback({});
  });

  session.webRequest.onHeadersReceived(filter, (details, callback) => {
    const top = topLevelUrl(details);
    if (top && details.responseHeaders && isThirdParty(details.url, top)) {
      const headers = { ...details.responseHeaders };
      for (const key of Object.keys(headers)) if (key.toLowerCase() === 'set-cookie') delete headers[key];
      callback({ responseHeaders: headers });
      return;
    }
    callback({});
  });
}

function handlePermissions(session: Session, getWindow: () => BrowserWindow | null): void {
  // Decisions last until the app quits; nothing about them is written to disk.
  const decisions = new Map<string, boolean>();
  const keyOf = (origin: string, permission: string) => `${origin}|${permission}`;

  session.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    if (ALWAYS_ALLOW.has(permission)) return callback(true);
    const what = ASK[permission];
    if (!what) return callback(false);

    let origin: string;
    try {
      origin = new URL(details.requestingUrl || wc.getURL()).origin;
    } catch {
      return callback(false);
    }
    const key = keyOf(origin, permission);
    const known = decisions.get(key);
    if (known !== undefined) return callback(known);

    const win = getWindow();
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      buttons: ['拒绝', '允许'],
      defaultId: 0,
      cancelId: 0,
      message: `${origin} 想要${what}`,
      detail: '本次运行期间会记住你的选择。',
    };
    const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    const allowed = response === 1;
    decisions.set(key, allowed);
    callback(allowed);
  });

  session.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (ALWAYS_ALLOW.has(permission)) return true;
    return decisions.get(keyOf(requestingOrigin, permission)) === true;
  });
}
