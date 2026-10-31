import { EncryptedStore, Param } from './store';

export type Transition = 'typed' | 'link' | 'bookmark' | 'back_forward' | 'reload' | 'new_tab';

export interface Visit {
  id: number;
  url: string;
  title: string;
  visited_at: number;
  duration_ms: number;
  transition: Transition;
  referrer_id: number | null;
  tab_id: number | null;
}

export const HISTORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  visited_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  transition TEXT NOT NULL,
  referrer_id INTEGER,
  tab_id INTEGER
);
CREATE INDEX IF NOT EXISTS visits_time ON visits(visited_at);
CREATE VIRTUAL TABLE IF NOT EXISTS visits_fts USING fts5(
  title, url, content='visits', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS visits_ai AFTER INSERT ON visits BEGIN
  INSERT INTO visits_fts(rowid, title, url) VALUES (new.id, new.title, new.url);
END;
CREATE TRIGGER IF NOT EXISTS visits_ad AFTER DELETE ON visits BEGIN
  INSERT INTO visits_fts(visits_fts, rowid, title, url) VALUES ('delete', old.id, old.title, old.url);
END;
CREATE TRIGGER IF NOT EXISTS visits_au AFTER UPDATE OF title, url ON visits BEGIN
  INSERT INTO visits_fts(visits_fts, rowid, title, url) VALUES ('delete', old.id, old.title, old.url);
  INSERT INTO visits_fts(rowid, title, url) VALUES (new.id, new.title, new.url);
END;
`;

export interface SearchOptions {
  query?: string;
  /** Only visits strictly older than this timestamp (for paging). */
  before?: number;
  limit?: number;
}

export class HistoryService {
  constructor(private readonly store: EncryptedStore) {}

  add(v: { url: string; title: string; at: number; transition: Transition; referrerId: number | null; tabId: number | null }): number {
    return this.store.run(
      'INSERT INTO visits (url, title, visited_at, transition, referrer_id, tab_id) VALUES (?, ?, ?, ?, ?, ?)',
      v.url,
      v.title,
      v.at,
      v.transition,
      v.referrerId,
      v.tabId,
    ).lastInsertRowid;
  }

  setTitle(id: number, title: string): void {
    this.store.run('UPDATE visits SET title = ? WHERE id = ? AND title != ?', title, id, title);
  }

  setDuration(id: number, ms: number): void {
    this.store.run('UPDATE visits SET duration_ms = ? WHERE id = ?', Math.max(0, Math.round(ms)), id);
  }

  search({ query, before, limit = 200 }: SearchOptions = {}): Visit[] {
    const q = query?.trim() ?? '';
    const where: string[] = [];
    const params: Param[] = [];
    if (before !== undefined) {
      where.push('v.visited_at < ?');
      params.push(before);
    }
    let from = 'visits v';
    if (q.length >= 3) {
      // The trigram index needs at least 3 characters; shorter queries fall back to LIKE.
      from = 'visits_fts f JOIN visits v ON v.id = f.rowid';
      where.push('visits_fts MATCH ?');
      params.push(`"${q.replace(/"/g, '""')}"`);
    } else if (q) {
      const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      where.push("(v.title LIKE ? ESCAPE '\\' OR v.url LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    const sql = `SELECT v.* FROM ${from} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY v.visited_at DESC, v.id DESC LIMIT ?`;
    return this.store.all<Visit>(sql, ...params, limit);
  }

  delete(ids: number[]): void {
    const clean = ids.filter((id) => Number.isInteger(id));
    if (clean.length === 0) return;
    this.store.batch(clean.map((id) => ({ sql: 'DELETE FROM visits WHERE id = ?', params: [id] })));
  }

  /** Delete visits at or after `since` (0 = everything). */
  deleteSince(since: number): number {
    return this.store.run('DELETE FROM visits WHERE visited_at >= ?', since).changes;
  }

  all(): Visit[] {
    return this.store.all<Visit>('SELECT * FROM visits ORDER BY visited_at ASC, id ASC');
  }

  count(): number {
    return this.store.get<{ n: number }>('SELECT count(*) AS n FROM visits')!.n;
  }
}

/** CSV with a header row; fields quoted when needed. */
export function visitsToCsv(visits: Visit[]): string {
  const cols: (keyof Visit)[] = ['id', 'visited_at', 'url', 'title', 'duration_ms', 'transition', 'referrer_id', 'tab_id'];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [...cols, 'visited_at_iso'].join(',');
  const rows = visits.map((v) => [...cols.map((c) => esc(v[c])), new Date(v.visited_at).toISOString()].join(','));
  return [header, ...rows].join('\n') + '\n';
}
