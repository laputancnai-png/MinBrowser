import { describe, expect, it } from 'vitest';
import { clampRatio, dropZone, ratioAt, SPLIT_GAP, SPLIT_PAD, splitRects, zoneRect } from '../src/shared/split';

const area = { x: 0, y: 84, width: 1200, height: 700 };

describe('split layout', () => {
  it('puts two panes side by side with the divider between them', () => {
    const { first, second, divider } = splitRects(area, 'horizontal', 0.5);
    expect(first.x).toBe(SPLIT_PAD);
    expect(divider.x).toBe(first.x + first.width);
    expect(second.x).toBe(divider.x + SPLIT_GAP);
    expect(second.x + second.width).toBe(area.width - SPLIT_PAD);
    expect(first.height).toBe(area.height - 2 * SPLIT_PAD);
    expect(Math.abs(first.width - second.width)).toBeLessThanOrEqual(1);
  });

  it('stacks two panes for top/bottom', () => {
    const { first, second, divider } = splitRects(area, 'vertical', 0.25);
    expect(first.y).toBe(area.y + SPLIT_PAD);
    expect(divider.y).toBe(first.y + first.height);
    expect(second.y + second.height).toBe(area.y + area.height - SPLIT_PAD);
    expect(first.height).toBeLessThan(second.height);
  });

  it('keeps each pane at least a fifth of the space', () => {
    expect(clampRatio(0.01)).toBe(0.2);
    expect(clampRatio(0.99)).toBe(0.8);
    expect(clampRatio(NaN)).toBe(0.5);
    expect(ratioAt(area, 'horizontal', 300, 400)).toBe(0.25);
    expect(ratioAt(area, 'vertical', 10, 84 + 700 * 0.6)).toBeCloseTo(0.6);
  });

  it('finds drop zones near the right and bottom edges', () => {
    expect(dropZone(area, 1100, 300)).toBe('right');
    expect(dropZone(area, 600, 750)).toBe('bottom');
    expect(dropZone(area, 600, 300)).toBeNull();
    expect(dropZone(area, 600, 40)).toBeNull(); // over the tab strip
    expect(zoneRect(area, 'right')).toEqual({ x: 600, y: 84, width: 600, height: 700 });
  });
});
