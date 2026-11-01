import { EncryptedStore } from './store';

export interface SessionTab {
  url: string;
  title: string;
}

export interface SavedSession {
  tabs: SessionTab[];
  activeIndex: number;
  /** Two tabs shown side by side / stacked, by position in `tabs`. */
  split?: { first: number; second: number; orientation: 'horizontal' | 'vertical'; ratio: number } | null;
}

export const SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_tabs (
  position INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  active INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/**
 * The tabs that are open right now, so they can come back after a crash or a
 * restart. Encrypted like everything else: open tabs are browsing history.
 * Every save goes straight to the journal, so a killed process loses nothing
 * that was saved.
 */
export class SessionService {
  private last = '';

  constructor(private readonly store: EncryptedStore) {
    this.last = JSON.stringify(this.load());
  }

  load(): SavedSession {
    const rows = this.store.all<{ url: string; title: string; active: number }>(
      'SELECT url, title, active FROM session_tabs ORDER BY position',
    );
    const activeIndex = Math.max(0, rows.findIndex((r) => r.active === 1));
    let split: SavedSession['split'] = null;
    const meta = this.store.get<{ value: string }>("SELECT value FROM session_meta WHERE key = 'split'");
    if (meta) {
      try {
        const s = JSON.parse(meta.value);
        if (Number.isInteger(s.first) && Number.isInteger(s.second) && s.first < rows.length && s.second < rows.length && s.first !== s.second) {
          split = { first: s.first, second: s.second, orientation: s.orientation === 'vertical' ? 'vertical' : 'horizontal', ratio: Number(s.ratio) || 0.5 };
        }
      } catch {
        split = null;
      }
    }
    return { tabs: rows.map((r) => ({ url: r.url, title: r.title })), activeIndex, split };
  }

  /** Replace the saved tabs. Does nothing if they haven't changed. */
  save(session: SavedSession): void {
    const normal = { ...session, split: session.split ?? null };
    const json = JSON.stringify(normal);
    if (json === this.last) return;
    this.store.batch([
      { sql: 'DELETE FROM session_tabs' },
      { sql: "DELETE FROM session_meta WHERE key = 'split'" },
      ...(normal.split ? [{ sql: "INSERT INTO session_meta (key, value) VALUES ('split', ?)", params: [JSON.stringify(normal.split)] }] : []),
      ...session.tabs.map((t, i) => ({
        sql: 'INSERT INTO session_tabs (position, url, title, active) VALUES (?, ?, ?, ?)',
        params: [i, t.url, t.title.slice(0, 500), i === session.activeIndex ? 1 : 0],
      })),
    ]);
    this.last = json;
  }

  clear(): void {
    this.save({ tabs: [], activeIndex: 0, split: null });
  }
}
