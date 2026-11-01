import { BrowserWindow, WebContents, WebContentsView } from 'electron';
import { join } from 'node:path';
import type { Rect } from '../shared/ipc';
import { UI_URL } from './pages';

/** Card plus room on each side for its shadow (see bookmark-popup.css). */
const WIDTH = 404;
const HEIGHT = 380;

/**
 * The bubble that opens under the star to name a bookmark and pick its
 * folder. Web pages are separate views drawn over the browser UI, so the
 * bubble is its own small transparent view stacked on top of them. It closes
 * as soon as it loses focus, like a menu.
 */
export class BookmarkPopup {
  private view: WebContentsView | null = null;
  bookmarkId: number | null = null;
  isNew = false;

  constructor(private readonly win: BrowserWindow) {
    win.on('resize', () => this.close());
  }

  show(bookmarkId: number, isNew: boolean, anchor: Rect): void {
    this.close();
    this.bookmarkId = bookmarkId;
    this.isNew = isNew;
    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '..', 'preload', 'popup.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    view.setBackgroundColor('#00000000');
    const [width] = this.win.getContentSize();
    // Right-align the bubble with the anchor's right edge, kept inside the window.
    const x = Math.round(Math.min(Math.max(anchor.x + anchor.width - WIDTH + 26, 4), width - WIDTH - 4));
    const y = Math.round(anchor.y + anchor.height);
    view.setBounds({ x, y, width: WIDTH, height: HEIGHT });
    this.win.contentView.addChildView(view);
    this.view = view;

    const wc = view.webContents;
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.once('did-finish-load', () => wc.focus());
    wc.on('blur', () => {
      if (this.view === view) this.close();
    });
    wc.loadURL(`${UI_URL}bookmark-popup.html`);
  }

  /** Shrink the view to the card's real height, so it doesn't cover the page below it. */
  fit(height: number): void {
    if (!this.view) return;
    const b = this.view.getBounds();
    this.view.setBounds({ ...b, height: Math.round(Math.min(Math.max(height, 120), 600)) });
  }

  owns(wc: WebContents): boolean {
    return !!this.view && this.view.webContents === wc;
  }

  get open(): boolean {
    return this.view !== null;
  }

  close(): void {
    const view = this.view;
    if (!view) return;
    this.view = null;
    this.bookmarkId = null;
    if (!this.win.isDestroyed()) this.win.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }
}
