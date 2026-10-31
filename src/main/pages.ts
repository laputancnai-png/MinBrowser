import { net, protocol, Session } from 'electron';
import { join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Internal pages live at min://<page>/<file> and are served from dist/pages/<page>/. */
const PAGES_DIR = join(__dirname, '..', 'pages');

/** Must run before app "ready". */
export function registerInternalScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'min', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

export function serveInternalPages(session: Session): void {
  session.protocol.handle('min', (request) => {
    const url = new URL(request.url);
    const file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const root = join(PAGES_DIR, url.hostname);
    const path = normalize(join(root, file));
    if (!url.hostname || !path.startsWith(root + sep)) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(path).href);
  });
}
