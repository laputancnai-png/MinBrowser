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
    return searchUrl(input);
  }

  if (/\s/.test(input)) return searchUrl(input);

  if (HOST_PORT_RE.test(input)) return toUrl(`http://${input}`) ?? searchUrl(input);

  const host = input.split(/[/?#]/, 1)[0].replace(/:\d+$/, '');
  // Only ICANN suffixes count here, so "github.io" is an address rather than a bare suffix.
  const info = parse(host);
  if (info.isIcann && info.domain) return toUrl(`https://${input}`) ?? searchUrl(input);

  return searchUrl(input);
}

/**
 * An address typed into a "网址" field (not the address bar): always taken as
 * an address, never turned into a search. Only http(s). Null if it isn't one.
 */
export function parseWebAddress(raw: string): string | null {
  const input = raw.trim();
  if (!input || /\s/.test(input)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(input) && !/^[^\s/]+:\d+/.test(input) ? input : `https://${input}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
    return url.href;
  } catch {
    return null;
  }
}

/** What the address bar shows for a URL. Internal pages show nothing. */
export function displayUrl(url: string): string {
  if (!url || url === NEW_TAB_URL || url === 'about:blank') return '';
  return url;
}

export function isInternalUrl(url: string): boolean {
  return url.startsWith('min:');
}

export function searchUrl(q: string): string {
  return SEARCH_URL + encodeURIComponent(q);
}

function toUrl(s: string): string | null {
  try {
    return new URL(s).href;
  } catch {
    return null;
  }
}

/** Query parameters that only exist to track you across sites. */
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid', 'twclid', 'ttclid',
  'igshid', 'li_fat_id', 'mc_cid', 'mc_eid', '_hsenc', '_hsmi', 'mkt_tok', 'oly_anon_id', 'oly_enc_id',
  'vero_id', 'wickedid', 'rb_clickid', 's_cid', 'spm',
]);

/** Parameters that often carry login secrets; never write them to history. */
const SECRET_PARAMS = new Set([
  'access_token', 'id_token', 'refresh_token', 'token', 'auth', 'auth_token', 'password', 'passwd', 'pwd',
  'session', 'sessionid', 'session_id', 'sid', 'api_key', 'apikey', 'secret', 'client_secret', 'code_verifier',
]);

/**
 * The URL as it should be stored in history: tracking parameters and secrets
 * removed. Non-http(s) URLs return null (they are never recorded).
 */
export function cleanUrlForHistory(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.username = '';
  url.password = '';
  for (const key of [...url.searchParams.keys()]) {
    const k = key.toLowerCase();
    if (k.startsWith('utm_') || TRACKING_PARAMS.has(k) || SECRET_PARAMS.has(k)) url.searchParams.delete(key);
  }
  // OAuth implicit flows put tokens in the fragment.
  if (/(^|[#&])(access_token|id_token|token)=/i.test(url.hash)) url.hash = '';
  return url.href;
}

/** The "origin" a saved password belongs to: scheme + host + port. */
export function originOf(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}
