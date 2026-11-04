/**
 * How a page is cut into pieces of text for translation (see
 * src/preload/page-translator.ts).
 *
 * The English → Chinese model cannot put HTML tags back in the right place, so
 * pages are translated as plain text:
 *  - a paragraph made only of text and simple formatting (bold, italic, span…)
 *    is translated as one piece, for the best quality; its translation goes
 *    into its first text node and the other text nodes are emptied;
 *  - a paragraph with links, line breaks, code or anything else is translated
 *    text node by text node, so links stay where they are and keep working.
 * Code, form fields, scripts and anything marked translate="no" are left alone.
 */

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'TEXTAREA',
  'INPUT', 'SELECT', 'OPTION', 'SVG', 'MATH', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'AUDIO', 'VIDEO',
]);
const INLINE_TAGS = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'DATA', 'DFN', 'EM', 'FONT', 'I', 'LABEL', 'MARK', 'Q', 'S',
  'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'BR', 'WBR', 'CODE', 'KBD', 'SAMP', 'VAR', 'IMG',
]);
const FORMAT_TAGS = ['abbr', 'b', 'bdi', 'cite', 'data', 'dfn', 'em', 'font', 'i', 'mark', 'q', 's', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u'];
const NOT_FORMAT = `:not(${FORMAT_TAGS.join(',')})`;
const OPTED_OUT = '[translate="no"], .notranslate, [contenteditable=""], [contenteditable="true"]';
/** Longer pieces are left as they are (they are rarely prose). */
export const MAX_UNIT_CHARS = 4000;

export interface TranslationUnit {
  /** The paragraph-like element the text belongs to (watched for coming into view). */
  block: Element;
  nodes: Text[];
  /** The nodes' text when the unit was made, to notice later changes. */
  captured: string[];
  /** What gets translated. */
  source: string;
}

const hasEnglish = (s: string) => /[A-Za-z]{2,}/.test(s);
const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Is the page (judged from a sample of its text) already Chinese, or without English? */
export function looksChinese(sample: string): boolean {
  const cjk = (sample.match(/[㐀-鿿豈-﫿]/g) ?? []).length;
  const latin = (sample.match(/[A-Za-z]/g) ?? []).length;
  // One Chinese character carries about as much as a short English word.
  return latin < 10 || cjk * 3 > latin;
}

export function planUnits(root: Node, isOurs: (n: Text) => boolean): TranslationUnit[] {
  const doc = root.ownerDocument ?? (root as Document);
  const skipCache = new Map<Element, boolean>();
  const skipped = (el: Element | null): boolean => {
    if (!el) return true;
    const cached = skipCache.get(el);
    if (cached !== undefined) return cached;
    const result = SKIP_TAGS.has(el.tagName.toUpperCase()) || el.closest(OPTED_OUT) !== null || (el.parentElement ? skipped(el.parentElement) : false);
    skipCache.set(el, result);
    return result;
  };
  const blockOf = (el: Element): Element => {
    let b: Element = el;
    while (INLINE_TAGS.has(b.tagName.toUpperCase()) && b.parentElement) b = b.parentElement;
    return b;
  };

  // Group the English text nodes by paragraph, in page order.
  const groups = new Map<Element, Text[]>();
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (!hasEnglish(n.data) || isOurs(n) || skipped(n.parentElement)) continue;
    const block = blockOf(n.parentElement!);
    const list = groups.get(block);
    if (list) list.push(n);
    else groups.set(block, [n]);
  }

  const units: TranslationUnit[] = [];
  for (const [block, candidates] of groups) {
    // One piece: only text and simple formatting inside, and nothing translated yet.
    const all: Text[] = [];
    const inner = doc.createTreeWalker(block, 4);
    for (let n = inner.nextNode() as Text | null; n; n = inner.nextNode() as Text | null) all.push(n);
    const whole = block.querySelector(NOT_FORMAT) === null && !all.some(isOurs);
    if (whole) {
      const nodes = all.filter((n) => n.data.length > 0);
      const source = tidy(nodes.map((n) => n.data).join(''));
      if (source.length <= MAX_UNIT_CHARS) {
        units.push({ block, nodes, captured: nodes.map((n) => n.data), source });
        continue;
      }
    }
    for (const n of candidates) {
      const source = tidy(n.data);
      if (source.length <= MAX_UNIT_CHARS) units.push({ block, nodes: [n], captured: [n.data], source });
    }
  }
  return units;
}
