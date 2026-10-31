import { app, DownloadItem, Session, shell } from 'electron';
import { existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

export interface DownloadInfo {
  id: number;
  filename: string;
  path: string;
  url: string;
  state: 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted';
  received: number;
  total: number;
  startedAt: number;
}

/** Pick "name (1).ext", "name (2).ext", ... if the name is taken. */
export function uniquePath(dir: string, filename: string, exists: (p: string) => boolean = existsSync): string {
  const safe = basename(filename).replace(/^\.+/, '') || 'download';
  const ext = extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  let candidate = join(dir, safe);
  for (let i = 1; exists(candidate); i++) candidate = join(dir, `${stem} (${i})${ext}`);
  return candidate;
}

/**
 * Downloads for this run only. The list is kept in memory and never written
 * to disk: what you downloaded is part of your private history.
 */
export class DownloadManager {
  private items = new Map<number, { item: DownloadItem; info: DownloadInfo }>();
  private nextId = 1;

  constructor(
    session: Session,
    private readonly options: () => { dir: string | null; ask: boolean },
    private readonly changed: () => void,
  ) {
    session.on('will-download', (_e, item) => this.track(item));
  }

  list(): DownloadInfo[] {
    return [...this.items.values()].map((d) => ({ ...d.info })).reverse();
  }

  activeCount(): number {
    return [...this.items.values()].filter((d) => d.info.state === 'progressing' || d.info.state === 'paused').length;
  }

  pause(id: number): void {
    this.items.get(id)?.item.pause();
    this.refresh(id);
  }

  resume(id: number): void {
    const d = this.items.get(id);
    if (d?.item.canResume()) d.item.resume();
    this.refresh(id);
  }

  cancel(id: number): void {
    this.items.get(id)?.item.cancel();
  }

  async open(id: number): Promise<void> {
    const d = this.items.get(id);
    if (d?.info.state === 'completed') await shell.openPath(d.info.path);
  }

  show(id: number): void {
    const d = this.items.get(id);
    if (d && existsSync(d.info.path)) shell.showItemInFolder(d.info.path);
  }

  /** Forget finished downloads (the files stay where they are). */
  clear(): void {
    for (const [id, d] of this.items) if (d.info.state !== 'progressing' && d.info.state !== 'paused') this.items.delete(id);
    this.changed();
  }

  private track(item: DownloadItem): void {
    const { dir, ask } = this.options();
    const folder = dir ?? app.getPath('downloads');
    if (ask) {
      item.setSaveDialogOptions({ defaultPath: join(folder, basename(item.getFilename())) });
    } else {
      item.setSavePath(uniquePath(folder, item.getFilename()));
    }
    const id = this.nextId++;
    const info: DownloadInfo = {
      id,
      filename: basename(item.getSavePath() || item.getFilename()),
      path: item.getSavePath(),
      url: item.getURL(),
      state: 'progressing',
      received: 0,
      total: item.getTotalBytes(),
      startedAt: Date.now(),
    };
    this.items.set(id, { item, info });
    item.on('updated', () => this.refresh(id));
    item.once('done', (_e, state) => {
      this.refresh(id);
      info.state = state;
      this.changed();
    });
    this.changed();
  }

  private refresh(id: number): void {
    const d = this.items.get(id);
    if (!d) return;
    const { item, info } = d;
    info.path = item.getSavePath() || info.path;
    if (info.path) info.filename = basename(info.path);
    info.received = item.getReceivedBytes();
    info.total = item.getTotalBytes();
    const state = item.getState();
    info.state = state === 'progressing' && item.isPaused() ? 'paused' : state;
    this.changed();
  }
}
