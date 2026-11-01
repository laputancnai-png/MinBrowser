import type { Rect } from './ipc';

/** 'horizontal' = side by side (left | right), 'vertical' = stacked (top / bottom). */
export type Orientation = 'horizontal' | 'vertical';

/** Space between the two panes; the divider handle lives in it. */
export const SPLIT_GAP = 8;
/** Margin around each pane, so the focus outline drawn behind the pages shows. */
export const SPLIT_PAD = 2;

export const clampRatio = (r: number) => Math.min(0.8, Math.max(0.2, Number.isFinite(r) ? r : 0.5));

/** Where the two panes and the divider go inside the page area. */
export function splitRects(area: Rect, orientation: Orientation, ratio: number): { first: Rect; second: Rect; divider: Rect } {
  const r = clampRatio(ratio);
  const P = SPLIT_PAD;
  const G = SPLIT_GAP;
  if (orientation === 'horizontal') {
    const usable = area.width - G - 2 * P;
    const w1 = Math.round(usable * r);
    const first = { x: area.x + P, y: area.y + P, width: w1, height: area.height - 2 * P };
    const divider = { x: first.x + w1, y: area.y, width: G, height: area.height };
    const second = { x: divider.x + G, y: area.y + P, width: usable - w1, height: area.height - 2 * P };
    return { first, second, divider };
  }
  const usable = area.height - G - 2 * P;
  const h1 = Math.round(usable * r);
  const first = { x: area.x + P, y: area.y + P, width: area.width - 2 * P, height: h1 };
  const divider = { x: area.x, y: first.y + h1, width: area.width, height: G };
  const second = { x: area.x + P, y: divider.y + G, width: area.width - 2 * P, height: usable - h1 };
  return { first, second, divider };
}

/** The ratio for a divider dragged to point (x, y). */
export function ratioAt(area: Rect, orientation: Orientation, x: number, y: number): number {
  return clampRatio(orientation === 'horizontal' ? (x - area.x) / area.width : (y - area.y) / area.height);
}

export type DropZone = 'right' | 'bottom';

/** Dropping a tab near the right edge splits side by side, near the bottom edge top/bottom. */
export function dropZone(area: Rect, x: number, y: number): DropZone | null {
  if (x < area.x || y < area.y || x > area.x + area.width || y > area.y + area.height) return null;
  if (x > area.x + area.width * 0.7) return 'right';
  if (y > area.y + area.height * 0.7) return 'bottom';
  return null;
}

/** The half of the page area a drop zone would take, for the preview. */
export function zoneRect(area: Rect, zone: DropZone): Rect {
  return zone === 'right'
    ? { x: area.x + area.width / 2, y: area.y, width: area.width / 2, height: area.height }
    : { x: area.x, y: area.y + area.height / 2, width: area.width, height: area.height / 2 };
}
