import type { Rect } from '../shared/ipc';

declare global {
  interface Window {
    shield: {
      send(kind: 'down' | 'move' | 'up' | 'cancel', x: number, y: number): void;
      onMode(cb: (mode: string, orientation: string) => void): void;
      onZone(cb: (rect: Rect | null) => void): void;
    };
  }
}

const zone = document.getElementById('zone')!;
const label = document.getElementById('label')!;

window.shield.onMode((mode, orientation) => {
  document.body.className = mode === 'handle' ? `handle handle-${orientation}` : 'tabdrop';
});

window.shield.onZone((rect) => {
  zone.hidden = !rect;
  if (!rect) return;
  zone.style.left = `${rect.x + 6}px`;
  zone.style.top = `${rect.y + 6}px`;
  zone.style.width = `${rect.width - 12}px`;
  zone.style.height = `${rect.height - 12}px`;
  label.textContent = rect.x > 0 ? '在右侧分屏打开' : '在下方分屏打开';
});

// Positions are sent in screen coordinates: this layer may be resized mid-drag
// (the divider handle grows to cover the pages), which shifts client coordinates.
let pending: { x: number; y: number } | null = null;
document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  document.body.setPointerCapture(e.pointerId);
  window.shield.send('down', e.screenX, e.screenY);
});
document.addEventListener('pointermove', (e) => {
  const first = !pending;
  pending = { x: e.screenX, y: e.screenY };
  if (first) {
    requestAnimationFrame(() => {
      if (pending) window.shield.send('move', pending.x, pending.y);
      pending = null;
    });
  }
});
document.addEventListener('pointerup', (e) => window.shield.send('up', e.screenX, e.screenY));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.shield.send('cancel', 0, 0);
});
