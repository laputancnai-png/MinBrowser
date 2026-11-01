import { app as electronApp, clipboard, dialog, ipcMain } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { Ipc } from '../shared/ipc';
import { generatePassword } from '../shared/password';
import { displayVersion } from '../shared/version';
import { originOf } from '../shared/url';
import type { BrowserApp } from './app';
import { BAR_ID, OTHER_ID } from './bookmarks';
import { findChromeProfiles, parseBookmarksFile, ParsedBookmarks } from './chrome-import';
import { Config } from './config';
import { visitsToCsv } from './history';

type Handler = (...args: unknown[]) => unknown;

const str = (v: unknown, max = 4096): string => {
  if (typeof v !== 'string' || v.length > max) throw new Error('bad argument');
  return v;
};
const int = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error('bad argument');
  return v;
};
const bool = (v: unknown): boolean => v === true;

const AUTO_LOCK_CHOICES = [0, 5, 15, 30, 60];
const CLIPBOARD_CLEAR_MS = 30_000;

/**
 * The API that internal min:// pages call. Each page may only use its own
 * namespace (min://history may call history.*), and only while unlocked.
 */
export function registerInternalApi(app: BrowserApp): void {
  const svc = () => {
    if (!app.services || app.phase !== 'unlocked') throw new Error('浏览器已锁定');
    return app.services;
  };
  const cfg = () => app.config!;

  const importParsed = (parsed: ParsedBookmarks) => {
    const b = svc().bookmarks;
    const bar = b.importTree(BAR_ID, parsed.bar);
    const other = parsed.other.length ? b.importTree(OTHER_ID, [{ type: 'folder', title: '从 Chrome 导入', children: parsed.other }]) : { links: 0, folders: 0 };
    app.emit();
    return { links: bar.links + other.links, folders: bar.folders + other.folders };
  };

  const handlers: Record<string, Handler> = {
    // ------------------------------------------------ history
    'history.search': (opts) => {
      const o = (opts ?? {}) as { query?: unknown; before?: unknown; limit?: unknown };
      return svc().history.search({
        query: o.query === undefined ? undefined : str(o.query, 500),
        before: o.before === undefined ? undefined : int(o.before),
        limit: o.limit === undefined ? 200 : Math.min(int(o.limit), 1000),
      });
    },
    'history.delete': (ids) => {
      if (!Array.isArray(ids)) throw new Error('bad argument');
      svc().history.delete(ids.map(int));
    },
    'history.deleteSince': (since) => svc().history.deleteSince(int(since)),
    'history.export': async (format) => {
      const fmt = str(format) === 'json' ? 'json' : 'csv';
      const date = new Date().toISOString().slice(0, 10);
      const res = await dialog.showSaveDialog(app.win!, {
        title: '导出浏览记录',
        defaultPath: `minbrowser-history-${date}.${fmt}`,
        filters: [{ name: fmt.toUpperCase(), extensions: [fmt] }],
      });
      if (res.canceled || !res.filePath) return null;
      const visits = svc().history.all();
      const body = fmt === 'json' ? JSON.stringify(visits, null, 2) : visitsToCsv(visits);
      writeFileSync(res.filePath, body, { mode: 0o600 });
      return { path: res.filePath, count: visits.length };
    },
    'history.open': (url, newTab) => app.openUrl(str(url), bool(newTab), 'link'),
    'history.status': () => ({ paused: cfg().get().recordingPaused }),
    'history.setPaused': (paused) => app.setRecordingPaused(bool(paused)),

    // ------------------------------------------------ bookmarks
    'bookmarks.tree': () => svc().bookmarks.tree(),
    'bookmarks.search': (q) => svc().bookmarks.search(str(q, 500)),
    'bookmarks.addLink': (parent, title, url, description) => {
      const u = str(url);
      if (!/^https?:\/\//i.test(u)) throw new Error('网址必须以 http:// 或 https:// 开头');
      const id = svc().bookmarks.addLink(int(parent), str(title, 500), u, Date.now(), description === undefined ? '' : str(description, 1000));
      app.emit();
      return id;
    },
    'bookmarks.addFolder': (parent, title) => {
      const id = svc().bookmarks.addFolder(int(parent), str(title, 500));
      app.emit();
      return id;
    },
    'bookmarks.update': (id, patch) => {
      const p = (patch ?? {}) as { title?: unknown; url?: unknown; description?: unknown };
      const url = p.url === undefined ? undefined : str(p.url);
      if (url !== undefined && !/^https?:\/\//i.test(url)) throw new Error('网址必须以 http:// 或 https:// 开头');
      svc().bookmarks.update(int(id), {
        title: p.title === undefined ? undefined : str(p.title, 500),
        url,
        description: p.description === undefined ? undefined : str(p.description, 1000),
      });
      app.emit();
    },
    'bookmarks.move': (id, parent, index) => {
      svc().bookmarks.move(int(id), int(parent), int(index));
      app.emit();
    },
    'bookmarks.moveMany': (ids, parent, index) => {
      if (!Array.isArray(ids) || ids.length > 5000) throw new Error('bad argument');
      svc().bookmarks.moveMany(ids.map(int), int(parent), int(index));
      app.emit();
    },
    'bookmarks.removeMany': (ids) => {
      if (!Array.isArray(ids) || ids.length > 5000) throw new Error('bad argument');
      svc().bookmarks.removeMany(ids.map(int));
      app.emit();
    },
    'bookmarks.remove': (id) => {
      svc().bookmarks.remove(int(id));
      app.emit();
    },
    'bookmarks.open': (url, newTab) => app.openUrl(str(url), bool(newTab), 'bookmark'),
    'bookmarks.profiles': () => findChromeProfiles().map((p, i) => ({ index: i, browser: p.browser, profile: p.profile })),
    // The page names a profile by index; it never gets to pick an arbitrary file path.
    'bookmarks.importProfile': (index) => {
      const profile = findChromeProfiles()[int(index)];
      if (!profile) throw new Error('找不到这个浏览器资料');
      return importParsed(parseBookmarksFile(readFileSync(profile.path, 'utf8')));
    },
    'bookmarks.importFile': async () => {
      const res = await dialog.showOpenDialog(app.win!, {
        title: '选择书签文件',
        properties: ['openFile'],
        filters: [{ name: '书签文件', extensions: ['html', 'htm', 'json', ''] }],
      });
      if (res.canceled || !res.filePaths[0]) return null;
      return importParsed(parseBookmarksFile(readFileSync(res.filePaths[0], 'utf8')));
    },

    // ------------------------------------------------ passwords
    'passwords.list': () => svc().passwords.list(),
    'passwords.reveal': (id) => svc().passwords.password(int(id)),
    'passwords.copy': async (id) => {
      const pw = svc().passwords.password(int(id));
      await clipboard.writeText(pw);
      // Only clear if the user hasn't copied something else since.
      setTimeout(async () => {
        if ((await clipboard.readText()) === pw) await clipboard.clear();
      }, CLIPBOARD_CLEAR_MS).unref();
    },
    'passwords.add': (origin, username, password) => {
      const o = originOf(str(origin)) ?? originOf(`https://${str(origin)}`);
      if (!o) throw new Error('请输入有效的网址');
      if (!str(password, 1024)) throw new Error('密码不能为空');
      return svc().passwords.save(o, str(username, 512), str(password, 1024));
    },
    'passwords.update': (id, patch) => {
      const p = (patch ?? {}) as { username?: unknown; password?: unknown };
      svc().passwords.update(int(id), {
        username: p.username === undefined ? undefined : str(p.username, 512),
        password: p.password === undefined ? undefined : str(p.password, 1024),
      });
    },
    'passwords.remove': (id) => {
      svc().passwords.remove(int(id));
      app.emit();
    },
    'passwords.generate': (length) => generatePassword(length === undefined ? 20 : Math.min(Math.max(int(length), 8), 128)),
    'passwords.neverList': () => svc().passwords.neverSaveList(),
    'passwords.unsetNever': (origin) => svc().passwords.setNeverSave(str(origin), false),

    // ------------------------------------------------ downloads
    'downloads.list': () => app.downloads?.list() ?? [],
    'downloads.pause': (id) => app.downloads?.pause(int(id)),
    'downloads.resume': (id) => app.downloads?.resume(int(id)),
    'downloads.cancel': (id) => app.downloads?.cancel(int(id)),
    'downloads.open': (id) => app.downloads?.open(int(id)),
    'downloads.show': (id) => app.downloads?.show(int(id)),
    'downloads.clear': () => app.downloads?.clear(),

    // ------------------------------------------------ settings
    'settings.get': () => ({
      config: cfg().get(),
      dataDir: app.dataDir,
      version: displayVersion(electronApp.getVersion()),
      adblock: {
        ...app.adblockStatus,
        builtin: app.adblock?.usingBuiltinRules ?? true,
      },
      allowList: svc().sites.adblockAllowList(),
    }),
    'settings.set': (patch) => {
      const p = (patch ?? {}) as Record<string, unknown>;
      const next: Partial<Config> = {};
      for (const key of ['askDownloadLocation', 'clearCookiesOnExit', 'adblockEnabled', 'showBookmarksBar', 'autofillPasswords', 'restoreSession'] as const) {
        if (key in p) next[key] = bool(p[key]);
      }
      if ('autoLockMinutes' in p) {
        const m = int(p.autoLockMinutes);
        if (!AUTO_LOCK_CHOICES.includes(m)) throw new Error('bad argument');
        next.autoLockMinutes = m;
      }
      if ('downloadDir' in p && p.downloadDir === null) next.downloadDir = null;
      if ('recordingPaused' in p) app.setRecordingPaused(bool(p.recordingPaused));
      cfg().set(next);
      app.emit();
      return cfg().get();
    },
    'settings.chooseDownloadDir': async () => {
      const res = await dialog.showOpenDialog(app.win!, { title: '选择下载位置', properties: ['openDirectory', 'createDirectory'] });
      if (res.canceled || !res.filePaths[0]) return null;
      cfg().set({ downloadDir: res.filePaths[0] });
      return res.filePaths[0];
    },
    'settings.changePassword': (current, next) => app.changePassword(str(current, 1024), str(next, 1024)),
    'settings.updateAdblock': () => app.maybeUpdateAdblock(true),
    'settings.removeAllow': (site) => {
      svc().sites.setAdblockAllowed(str(site), false);
      app.emit();
    },
    'settings.clearSiteData': async () => {
      await app.web?.clearStorageData();
      await app.web?.clearCache();
    },
    'settings.lock': () => app.lock(),
  };

  ipcMain.handle(Ipc.Internal, async (e, method: unknown, args: unknown) => {
    const frame = e.senderFrame;
    if (!frame || frame.parent !== null || !app.tabs?.byWebContents(e.sender)) throw new Error('forbidden');
    let page: URL;
    try {
      page = new URL(frame.url);
    } catch {
      throw new Error('forbidden');
    }
    if (page.protocol !== 'min:' || typeof method !== 'string' || method.split('.')[0] !== page.hostname) {
      throw new Error('forbidden');
    }
    const handler = handlers[method];
    if (!handler) throw new Error(`unknown method ${method}`);
    return handler(...(Array.isArray(args) ? args : []));
  });
}
