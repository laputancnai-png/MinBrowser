import { ipcRenderer } from 'electron';
import { Ipc } from '../shared/ipc';
import { looksChinese, planUnits, TranslationUnit } from '../shared/page-text';

/**
 * Translates the page in place, English → Chinese. Runs in the tab's isolated
 * world. Only the text of existing text nodes is changed: no HTML is ever
 * inserted and the page's structure stays as it was, so "show original" puts
 * every text back exactly and the page's own scripts keep working.
 *
 * Only what is on (or near) the screen is translated; the rest follows as it
 * scrolls into view, and content the page adds later is picked up too.
 */

const BATCH_UNITS = 40;
const BATCH_CHARS = 8000;

let active = false;
/** Text node → its original text, for restoring. */
const originals = new Map<Text, string>();
/** Text node → what we wrote into it, to notice when the page changes it again. */
const written = new WeakMap<Text, string>();
/** Units waiting for their block to come into view. */
const waiting = new Map<Element, TranslationUnit[]>();
const queue: TranslationUnit[] = [];
let inFlight = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let intersections: IntersectionObserver | null = null;
let mutations: MutationObserver | null = null;
let rescanTimer: ReturnType<typeof setTimeout> | null = null;
let lastStatus = '';

function status(s: 'busy' | 'idle' | 'not-english' | 'error', detail?: string): void {
  if (s === lastStatus && !detail) return;
  lastStatus = s;
  ipcRenderer.send(Ipc.TranslateStatus, s, detail);
}

function updateStatus(): void {
  status(inFlight > 0 || queue.length > 0 ? 'busy' : 'idle');
}

function scan(root: Node): void {
  for (const unit of planUnits(root, (n) => originals.has(n) && written.get(n) === n.data)) {
    const list = waiting.get(unit.block) ?? [];
    list.push(unit);
    if (!waiting.has(unit.block)) {
      waiting.set(unit.block, list);
      intersections?.observe(unit.block);
    }
  }
}

function enqueue(units: TranslationUnit[]): void {
  queue.push(...units);
  updateStatus();
  if (!flushTimer) flushTimer = setTimeout(flush, 30);
}

async function flush(): Promise<void> {
  flushTimer = null;
  if (!active || queue.length === 0) return;
  const batch: TranslationUnit[] = [];
  let chars = 0;
  while (queue.length && batch.length < BATCH_UNITS && chars < BATCH_CHARS) {
    const u = queue.shift()!;
    batch.push(u);
    chars += u.source.length;
  }
  if (queue.length) flushTimer = setTimeout(flush, 0);
  inFlight++;
  updateStatus();
  try {
    const out = (await ipcRenderer.invoke(Ipc.TranslateTexts, batch.map((u) => u.source))) as string[];
    if (!active) return;
    batch.forEach((u, i) => apply(u, out[i] ?? ''));
  } catch (err) {
    if (active) status('error', err instanceof Error ? err.message : String(err));
  } finally {
    inFlight--;
    if (active) updateStatus();
  }
}

function apply(unit: TranslationUnit, translation: string): void {
  // The page changed this text while it was being translated: leave it alone.
  if (!translation || unit.nodes.some((n, i) => n.data !== unit.captured[i] || !n.isConnected)) return;
  unit.nodes.forEach((n, i) => {
    if (!originals.has(n)) originals.set(n, n.data);
    const lead = i === 0 ? /^\s*/.exec(unit.captured[0])![0] : '';
    const trail = i === unit.nodes.length - 1 ? /\s*$/.exec(unit.captured[i])![0] : '';
    const value = i === 0 ? `${lead}${translation}${trail}` : trail;
    n.data = value;
    written.set(n, value);
  });
}

function start(): void {
  if (active) return;
  const sample = (document.body?.innerText ?? '').slice(0, 5000);
  if (looksChinese(sample)) {
    status('not-english');
    return;
  }
  active = true;
  lastStatus = '';
  intersections = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        intersections?.unobserve(e.target);
        const units = waiting.get(e.target);
        waiting.delete(e.target);
        if (units) enqueue(units);
      }
    },
    { rootMargin: '800px 0px' },
  );
  // New content, or the page rewriting text we translated: translate that too.
  mutations = new MutationObserver((records) => {
    if (records.some((r) => r.type === 'childList' || (r.target instanceof Text && written.get(r.target) !== r.target.data))) {
      if (!rescanTimer) rescanTimer = setTimeout(() => {
        rescanTimer = null;
        if (active && document.body) scan(document.body);
      }, 300);
    }
  });
  if (document.body) {
    scan(document.body);
    mutations.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  updateStatus();
}

function restore(): void {
  active = false;
  intersections?.disconnect();
  mutations?.disconnect();
  intersections = null;
  mutations = null;
  if (flushTimer) clearTimeout(flushTimer);
  if (rescanTimer) clearTimeout(rescanTimer);
  flushTimer = rescanTimer = null;
  queue.length = 0;
  waiting.clear();
  for (const [node, original] of originals) {
    // Only put back what is still our translation.
    if (written.get(node) === node.data) node.data = original;
  }
  originals.clear();
  lastStatus = '';
}

export function startPageTranslator(): void {
  ipcRenderer.on(Ipc.TranslateStart, () => start());
  ipcRenderer.on(Ipc.TranslateRestore, () => restore());
}
