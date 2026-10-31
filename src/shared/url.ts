import { parse } from 'tldts';

export const SEARCH_URL = 'https://duckduckgo.com/?q=';
export const NEW_TAB_URL = 'min://newtab/';

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'min:', 'file:']);
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const HOST_PORT_RE = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(\/.*)?$/i;

/**
 * Turn whatever the user typed into the address bar into a URL to load.
 * Anything that doesn't look like an address becomes a DuckDuckGo search.
 */
export function resolveInput(raw: string): string | null {
  const input = raw.trim();
  if (!input) return null;

  if (input === 'about:blank') return input;

  if (SCHEME_RE.test(input) && !/^[^\s/]+:\d+/.test(input)) {
    try {
      const url = new URL(input);
      if (ALLOWED_SCHEMES.has(url.protocol)) return url.href;
    } catch {
      // fall through to search
    }
    return search(input);
  }

  if (/\s/.test(input)) return search(input);

  if (HOST_PORT_RE.test(input)) return toUrl(`http://${input}`) ?? search(input);

  const host = input.split(/[/?#]/, 1)[0].replace(/:\d+$/, '');
  // Only ICANN suffixes count here, so "github.io" is an address rather than a bare suffix.
  const info = parse(host);
  if (info.isIcann && info.domain) return toUrl(`https://${input}`) ?? search(input);

  return search(input);
}

/** What the address bar shows for a URL. Internal pages show nothing. */
export function displayUrl(url: string): string {
  if (!url || url === NEW_TAB_URL || url === 'about:blank') return '';
  return url;
}

export function isInternalUrl(url: string): boolean {
  return url.startsWith('min:');
}

function search(q: string): string {
  return SEARCH_URL + encodeURIComponent(q);
}

function toUrl(s: string): string | null {
  try {
    return new URL(s).href;
  } catch {
    return null;
  }
}
