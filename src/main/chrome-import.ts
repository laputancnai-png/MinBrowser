import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ImportNode } from './bookmarks';

export interface ChromeProfile {
  browser: string;
  profile: string;
  path: string; // the Bookmarks file
}

const BROWSERS: Record<string, { mac: string; linux: string }> = {
  'Google Chrome': { mac: 'Google/Chrome', linux: 'google-chrome' },
  'Chrome Beta': { mac: 'Google/Chrome Beta', linux: 'google-chrome-beta' },
  Chromium: { mac: 'Chromium', linux: 'chromium' },
  Brave: { mac: 'BraveSoftware/Brave-Browser', linux: 'BraveSoftware/Brave-Browser' },
  'Microsoft Edge': { mac: 'Microsoft Edge', linux: 'microsoft-edge' },
};

/** Find Chrome-family profiles on this machine that have a Bookmarks file. */
export function findChromeProfiles(home = homedir(), platform = process.platform): ChromeProfile[] {
  const base = platform === 'darwin' ? join(home, 'Library', 'Application Support') : join(home, '.config');
  const found: ChromeProfile[] = [];
  for (const [browser, dirs] of Object.entries(BROWSERS)) {
    const root = join(base, platform === 'darwin' ? dirs.mac : dirs.linux);
    if (!existsSync(root)) continue;
    let names: Record<string, string> = {};
    try {
      const state = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8'));
      for (const [dir, info] of Object.entries<{ name?: string }>(state?.profile?.info_cache ?? {})) {
        if (info?.name) names[dir] = info.name;
      }
    } catch {
      names = {};
    }
    for (const dir of readdirSync(root)) {
      if (dir !== 'Default' && !/^Profile \d+$/.test(dir)) continue;
      const path = join(root, dir, 'Bookmarks');
      if (existsSync(path)) found.push({ browser, profile: names[dir] ?? dir, path });
    }
  }
  return found;
}

interface ChromeNode {
  type?: string;
  name?: string;
  url?: string;
  children?: ChromeNode[];
}

const importable = (url: string | undefined): url is string => !!url && /^https?:\/\//i.test(url);

function convert(nodes: ChromeNode[] | undefined): ImportNode[] {
  const out: ImportNode[] = [];
  for (const n of nodes ?? []) {
    if (n.type === 'url' && importable(n.url)) out.push({ type: 'link', title: n.name ?? n.url, url: n.url });
    else if (n.type === 'folder') out.push({ type: 'folder', title: n.name ?? '文件夹', children: convert(n.children) });
  }
  return out;
}

export interface ParsedBookmarks {
  bar: ImportNode[];
  other: ImportNode[];
}

/** Chrome's own "Bookmarks" JSON file. */
export function parseChromeBookmarksJson(text: string): ParsedBookmarks {
  const data = JSON.parse(text);
  const roots = data?.roots;
  if (!roots || typeof roots !== 'object') throw new Error('不是 Chrome 的书签文件');
  const other = convert(roots.other?.children);
  const synced = convert(roots.synced?.children);
  if (synced.length) other.push({ type: 'folder', title: '移动设备书签', children: synced });
  return { bar: convert(roots.bookmark_bar?.children), other };
}

const decodeEntities = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

/**
 * The "bookmarks.html" export format (Netscape bookmark file) used by Chrome,
 * Firefox, Safari and Edge. A folder marked PERSONAL_TOOLBAR_FOLDER becomes the bar.
 */
export function parseBookmarksHtml(html: string): ParsedBookmarks {
  const root: ImportNode & { type: 'folder' } = { type: 'folder', title: '', children: [] };
  const stack: (ImportNode & { type: 'folder' })[] = [root];
  let pendingFolder: (ImportNode & { type: 'folder' }) | null = null;
  let toolbar: (ImportNode & { type: 'folder' }) | null = null;
  const re = /<DT>\s*<H3([^>]*)>([\s\S]*?)<\/H3>|<DT>\s*<A\s([^>]*)>([\s\S]*?)<\/A>|<DD>([^<]*)|<DL[^>]*>|<\/DL>/gi;
  let m: RegExpExecArray | null;
  // A <DD> right after a link is that link's description.
  let lastLink: (ImportNode & { type: 'link' }) | null = null;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[5] !== undefined) {
      const text = decodeEntities(m[5].trim());
      if (lastLink && text) lastLink.description = text;
      lastLink = null;
      continue;
    }
    lastLink = null;
    if (m[2] !== undefined) {
      const folder: ImportNode & { type: 'folder' } = { type: 'folder', title: decodeEntities(m[2].trim()), children: [] };
      top.children.push(folder);
      if (/PERSONAL_TOOLBAR_FOLDER\s*=\s*"true"/i.test(m[1]) && !toolbar) toolbar = folder;
      pendingFolder = folder;
    } else if (m[3] !== undefined) {
      const href = /HREF\s*=\s*"([^"]*)"/i.exec(m[3])?.[1];
      const url = href ? decodeEntities(href) : undefined;
      if (importable(url)) {
        lastLink = { type: 'link', title: decodeEntities(m[4].trim()) || url, url };
        top.children.push(lastLink);
      }
    } else if (m[0].toUpperCase().startsWith('<DL')) {
      if (pendingFolder) stack.push(pendingFolder);
      pendingFolder = null;
    } else if (stack.length > 1) {
      stack.pop();
    }
  }
  if (toolbar) {
    root.children.splice(root.children.indexOf(toolbar), 1);
    return { bar: toolbar.children, other: root.children };
  }
  return { bar: [], other: root.children };
}

export function parseBookmarksFile(text: string): ParsedBookmarks {
  return text.trimStart().startsWith('{') ? parseChromeBookmarksJson(text) : parseBookmarksHtml(text);
}
