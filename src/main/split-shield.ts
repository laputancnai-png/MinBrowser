import { BrowserWindow, WebContents, WebContentsView } from 'electron';
import { join } from 'node:path';
import { Ipc, Rect } from '../shared/ipc';
import type { Orientation } from '../shared/split';
import { UI_URL } from './pages';

/**
 * A transparent layer over the page area, shown only while the split divider
 * or a tab is being dragged. Pages are separate views stacked over the browser
 * UI, so once the pointer is over a page the UI may stop seeing it; this
 * layer catches the pointer there and draws the drop preview.
 *
 * The layer is created and loaded once, ahead of time: starting a page
 * process takes long enough that a freshly created layer would miss the first
 * moves (and possibly the release) of a quick drag.
 */
export class SplitShield {
  private view: WebContentsView | null = null;
  private shown = false;
  private area: Rect = { x: 0, y: 0, width: 0, height: 0 };

  constructor(private readonly win: BrowserWindow) {
    this.prepare();
    win.on('closed', () => {
      if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close();
      this.view = null;
    });
  }

  private prepare(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '..', 'preload', 'shield.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    view.setBackgroundColor('#00000000');
    const wc = view.webContents;
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    // If the layer's process dies, make a fresh one next time.
    wc.on('render-process-gone', () => {
      if (this.view === view) this.view = null;
    });
    wc.loadURL(`${UI_URL}split-shield.html`);
    this.view = view;
    return view;
  }

  show(mode: 'handle' | 'tabdrop', orientation: Orientation, area: Rect): void {
    const view = this.prepare();
    this.area = area;
    view.setBounds(area);
    if (!this.shown) this.win.contentView.addChildView(view);
    this.shown = true;
    view.webContents.send(Ipc.ShieldMode, mode, orientation);
    view.webContents.send(Ipc.ShieldZone, null);
  }

  /** Move/resize without re-sending the mode (e.g. the divider handle growing for a drag). */
  setBounds(area: Rect): void {
    if (!this.view || !this.shown) return;
    this.area = area;
    this.view.setBounds(area);
  }

  /** Put the layer back on top, after page views were added above it. */
  raise(): void {
    if (!this.view || !this.shown || this.win.isDestroyed()) return;
    const children = this.win.contentView.children;
    if (children[children.length - 1] === this.view) return;
    this.win.contentView.removeChildView(this.view);
    this.win.contentView.addChildView(this.view);
  }

  get isShown(): boolean {
    return this.shown;
  }

  /** Highlight where a dropped tab would go (window coordinates), or nothing. */
  setZone(rect: Rect | null): void {
    if (!this.view || !this.shown) return;
    const local = rect && { x: rect.x - this.area.x, y: rect.y - this.area.y, width: rect.width, height: rect.height };
    this.view.webContents.send(Ipc.ShieldZone, local);
  }

  owns(wc: WebContents): boolean {
    return this.shown && !!this.view && this.view.webContents === wc;
  }


  hide(): void {
    if (!this.shown || !this.view) return;
    this.shown = false;
    this.view.webContents.send(Ipc.ShieldZone, null);
    if (!this.win.isDestroyed()) this.win.contentView.removeChildView(this.view);
  }
}
