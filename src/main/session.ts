import { EncryptedStore } from './store';

export interface SessionTab {
  url: string;
  title: string;
}

export interface SavedSession {
  tabs: SessionTab[];
  activeIndex: number;
}

export const SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_tabs (
  position INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  active INTEGER NOT NULL
);
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
    return { tabs: rows.map((r) => ({ url: r.url, title: r.title })), activeIndex };
  }

  /** Replace the saved tabs. Does nothing if they haven't changed. */
  save(session: SavedSession): void {
    const json = JSON.stringify(session);
    if (json === this.last) return;
    this.store.batch([
      { sql: 'DELETE FROM session_tabs' },
      ...session.tabs.map((t, i) => ({
        sql: 'INSERT INTO session_tabs (position, url, title, active) VALUES (?, ?, ?, ?)',
        params: [i, t.url, t.title.slice(0, 500), i === session.activeIndex ? 1 : 0],
      })),
    ]);
    this.last = json;
  }

  clear(): void {
    this.save({ tabs: [], activeIndex: 0 });
  }
}
