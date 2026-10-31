import { parse } from 'tldts';

/** The registrable domain ("site") of a URL, e.g. news.bbc.co.uk -> bbc.co.uk. */
export function siteOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname;
  if (!host || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return null;
  const info = parse(host, { allowPrivateDomains: true });
  return info.domain ?? host;
}

/**
 * True when a request goes to a different site than the page the user is on.
 * Unknown/opaque origins count as first-party so we never break internal pages.
 */
export function isThirdParty(requestUrl: string, topLevelUrl: string): boolean {
  const req = siteOf(requestUrl);
  const top = siteOf(topLevelUrl);
  if (!req || !top) return false;
  return req !== top;
}

/** Strip the Electron and app tokens from the UA so we look like plain Chrome. */
export function cleanUserAgent(ua: string): string {
  return ua
    .replace(/\s(?:Electron|minbrowser|MinBrowser)\/\S+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
