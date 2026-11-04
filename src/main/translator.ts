import { ipcMain, session, WebContentsView } from 'electron';
import { join } from 'node:path';
import { Ipc } from '../shared/ipc';
import { serveTranslator, TRANSLATOR_URL } from './pages';
import type { LoadedFiles } from './translation-models';

/** Free the engine's memory (~150 MB) after this long without use. */
const IDLE_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60 * 1000;

let sessionReady = false;

/**
 * The engine's own session: in memory only, serves nothing but the engine
 * page, and refuses every network request, so whatever runs in there cannot
 * send page text anywhere.
 */
function engineSession(): Electron.Session {
  const ses = session.fromPartition('minbrowser-translator');
  if (!sessionReady) {
    sessionReady = true;
    serveTranslator(ses);
    ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !details.url.startsWith(TRANSLATOR_URL) }));
    ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
  }
  return ses;
}

export interface Translator {
  translate(texts: string[]): Promise<string[]>;
  stop(): void;
}

/**
 * Runs Mozilla's translation engine in a hidden, sandboxed page (with a worker),
 * started on first use and stopped when idle or when the browser locks.
 */
export class EngineTranslator implements Translator {
  private view: WebContentsView | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: string[]) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private idleTimer: NodeJS.Timeout | null = null;
  private readyWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(private readonly loadFiles: () => LoadedFiles) {
    ipcMain.on(Ipc.TranslatorReady, (e, ok: unknown, error: unknown) => {
      if (!this.owns(e.sender) || !this.readyWaiter) return;
      if (ok === true) this.readyWaiter.resolve();
      else this.readyWaiter.reject(new Error(typeof error === 'string' ? error : '翻译引擎启动失败'));
      this.readyWaiter = null;
    });
    ipcMain.on(Ipc.TranslatorReply, (e, id: unknown, ok: unknown, value: unknown) => {
      if (!this.owns(e.sender) || typeof id !== 'number') return;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (ok === true && Array.isArray(value) && value.every((v) => typeof v === 'string')) p.resolve(value);
      else p.reject(new Error(typeof value === 'string' ? value : '翻译失败'));
    });
  }

  private owns(wc: Electron.WebContents): boolean {
    return !!this.view && !this.view.webContents.isDestroyed() && this.view.webContents === wc;
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const view = new WebContentsView({
      webPreferences: {
        session: engineSession(),
        preload: join(__dirname, '..', 'preload', 'translator.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    this.view = view;
    const wc = view.webContents;
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('render-process-gone', () => {
      if (this.view === view) this.stop(new Error('翻译引擎意外退出，请再试一次'));
    });
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyWaiter = { resolve, reject };
      wc.once('did-finish-load', () => {
        try {
          const files = this.loadFiles();
          wc.send(Ipc.TranslatorInit, { wasm: files.wasm, model: files.model });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      wc.loadURL(`${TRANSLATOR_URL}index.html`).catch(reject);
    });
    this.ready.catch(() => this.stop());
    return this.ready;
  }

  async translate(texts: string[]): Promise<string[]> {
    if (texts.length === 0) return [];
    await this.start();
    this.touch();
    const id = this.nextId++;
    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('翻译超时'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.view!.webContents.send(Ipc.TranslatorRequest, id, texts);
    });
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), IDLE_MS);
  }

  stop(reason = new Error('翻译已停止')): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
    this.pending.clear();
    this.readyWaiter?.reject(reason);
    this.readyWaiter = null;
    const view = this.view;
    this.view = null;
    this.ready = null;
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
  }
}

/** For tests in development builds: "translates" without downloading anything. */
export class FakeTranslator implements Translator {
  async translate(texts: string[]): Promise<string[]> {
    return texts.map((t) => `【译】${t}`);
  }
  stop(): void {}
}
