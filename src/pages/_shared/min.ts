// Helpers shared by the internal min:// pages.

declare global {
  interface Window {
    min: { call(method: string, ...args: unknown[]): Promise<unknown> };
  }
}

export function call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
  return window.min.call(method, ...args) as Promise<T>;
}

type Child = Node | string | null | undefined | false;
type Props = {
  class?: string;
  text?: string;
  title?: string;
  on?: Partial<Record<keyof HTMLElementEventMap, (e: Event) => void>>;
  [attr: string]: unknown;
};

/** Tiny element builder. Text always goes in as text, never as HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'text') el.textContent = String(value);
    // The CSP forbids style attributes; styles set through the CSSOM are allowed.
    else if (key === 'style') el.style.cssText = String(value);
    else if (key === 'on') for (const [ev, fn] of Object.entries(value as object)) el.addEventListener(ev, fn as EventListener);
    else if (key in el && typeof value !== 'string') (el as unknown as Record<string, unknown>)[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

const PAGES: [string, string][] = [
  ['history', '历史记录'],
  ['bookmarks', '收藏夹'],
  ['passwords', '密码'],
  ['downloads', '下载'],
  ['settings', '设置'],
];

/** Page frame: header with navigation, returns the <main> to fill. */
export function shell(page: string, title: string): HTMLElement {
  document.title = title;
  const nav = h('nav', {}, ...PAGES.map(([id, label]) => h('a', { href: `min://${id}/`, text: label, class: id === page ? 'active' : '' })));
  const brand = h('div', { class: 'brand' }, 'Min', h('span', { text: 'Browser' }));
  const main = h('main');
  document.body.replaceChildren(h('header', { class: 'top' }, brand, nav), main);
  return main;
}

export function toast(message: string): void {
  const t = h('div', { class: 'toast', text: message });
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

/** Run an action and show its error, if any, as a toast. */
export async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    toast(String((err as Error).message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    return undefined;
  }
}

export const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

export function fmtDay(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const date = d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  if (same(d, today)) return `今天 · ${date}`;
  if (same(d, yesterday)) return `昨天 · ${date}`;
  return date;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

export function fmtBytes(n: number): string {
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

export const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Opening links: plain click = this tab, Cmd/Ctrl or middle click = new tab. */
export const wantsNewTab = (e: MouseEvent) => e.metaKey || e.ctrlKey || e.button === 1;
