import { protocol, Session } from 'electron';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

/**
 * The browser's own pages are served over private schemes instead of file://
 * (file:// pages get extra privileges, and packaged builds switch those off):
 *
 *   app://ui/<file>     the browser UI, bookmark bubble, split layers
 *                       (default session only, so web pages can't load them)
 *   min://<page>/<file> internal pages shown in tabs (history, passwords, ...)
 *
 * Files are read with fs, which also works inside the packaged app.asar.
 */
const DIST = join(__dirname, '..');
const RENDERER_DIR = join(DIST, 'renderer');
const PAGES_DIR = join(DIST, 'pages');
const TRANSLATOR_DIR = join(DIST, 'translator');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
};

/** Must run before app "ready". */
export function registerInternalScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'min', privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

export const UI_URL = 'app://ui/';

/** Resolve `pathname` inside `root`, refusing anything that escapes it. */
async function serveFile(root: string, pathname: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  let file: string;
  try {
    file = pathname === '/' || pathname === '' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  const path = normalize(join(root, file));
  if (!path.startsWith(root + sep)) return new Response('Not found', { status: 404 });
  try {
    const body = await readFile(path);
    return new Response(body, { headers: { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', ...extraHeaders } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

/** Internal pages for tabs, in the web session. */
export function serveInternalPages(session: Session): void {
  session.protocol.handle('min', (request) => {
    const url = new URL(request.url);
    if (!url.hostname) return new Response('Not found', { status: 404 });
    return serveFile(join(PAGES_DIR, url.hostname), url.pathname);
  });
}

/** The browser's own UI, in the default session (which never loads web content). */
export function serveBrowserUi(session: Session): void {
  session.protocol.handle('app', (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'ui') return new Response('Not found', { status: 404 });
    return serveFile(RENDERER_DIR, url.pathname);
  });
}

/**
 * The translation engine page, only in its own session (see translator.ts).
 * The policy is sent as a header so it also covers the engine's worker: run
 * our own scripts and WebAssembly, load nothing else, no eval.
 */
export const TRANSLATOR_URL = 'app://translator/';
export const TRANSLATOR_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'";
export function serveTranslator(session: Session): void {
  session.protocol.handle('app', (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'translator') return new Response('Not found', { status: 404 });
    return serveFile(TRANSLATOR_DIR, url.pathname, { 'content-security-policy': TRANSLATOR_CSP });
  });
}
