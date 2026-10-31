import { EncryptedStore, Op } from './store';

export const BAR_ID = 1;
export const OTHER_ID = 2;

export interface Bookmark {
  id: number;
  parent_id: number | null;
  type: 'folder' | 'link';
  title: string;
  url: string | null;
  position: number;
  created_at: number;
}

export interface BookmarkNode extends Bookmark {
  children?: BookmarkNode[];
}

/** A tree to import, e.g. parsed from Chrome. */
export type ImportNode = { type: 'link'; title: string; url: string } | { type: 'folder'; title: string; children: ImportNode[] };

export const BOOKMARKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER,
  type TEXT NOT NULL CHECK (type IN ('folder', 'link')),
  title TEXT NOT NULL,
  url TEXT,
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bookmarks_parent ON bookmarks(parent_id, position);
CREATE INDEX IF NOT EXISTS bookmarks_url ON bookmarks(url);
INSERT OR IGNORE INTO bookmarks VALUES (${BAR_ID}, NULL, 'folder', '收藏夹栏', NULL, 0, 0);
INSERT OR IGNORE INTO bookmarks VALUES (${OTHER_ID}, NULL, 'folder', '其他收藏', NULL, 1, 0);
`;

export class BookmarkService {
  constructor(private readonly store: EncryptedStore) {}

  children(parentId: number): Bookmark[] {
    return this.store.all<Bookmark>('SELECT * FROM bookmarks WHERE parent_id = ? ORDER BY position, id', parentId);
  }

  get(id: number): Bookmark | undefined {
    return this.store.get<Bookmark>('SELECT * FROM bookmarks WHERE id = ?', id);
  }

  tree(): BookmarkNode[] {
    const rows = this.store.all<Bookmark>('SELECT * FROM bookmarks ORDER BY position, id');
    const byParent = new Map<number | null, BookmarkNode[]>();
    for (const r of rows) {
      const list = byParent.get(r.parent_id) ?? [];
      list.push({ ...r });
      byParent.set(r.parent_id, list);
    }
    const attach = (n: BookmarkNode): BookmarkNode =>
      n.type === 'folder' ? { ...n, children: (byParent.get(n.id) ?? []).map(attach) } : n;
    return (byParent.get(null) ?? []).map(attach);
  }

  isBookmarked(url: string): boolean {
    return this.store.get('SELECT 1 FROM bookmarks WHERE url = ? LIMIT 1', url) !== undefined;
  }

  addLink(parentId: number, title: string, url: string, at = Date.now()): number {
    this.assertFolder(parentId);
    return this.store.run(
      'INSERT INTO bookmarks (parent_id, type, title, url, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      parentId,
      'link',
      title || url,
      url,
      this.nextPosition(parentId),
      at,
    ).lastInsertRowid;
  }

  addFolder(parentId: number, title: string, at = Date.now()): number {
    this.assertFolder(parentId);
    return this.store.run(
      'INSERT INTO bookmarks (parent_id, type, title, url, position, created_at) VALUES (?, ?, ?, NULL, ?, ?)',
      parentId,
      'folder',
      title || '新文件夹',
      this.nextPosition(parentId),
      at,
    ).lastInsertRowid;
  }

  update(id: number, patch: { title?: string; url?: string }): void {
    const b = this.get(id);
    if (!b || b.parent_id === null) return;
    const title = patch.title?.trim() || b.title;
    const url = b.type === 'link' ? patch.url?.trim() || b.url : null;
    this.store.run('UPDATE bookmarks SET title = ?, url = ? WHERE id = ?', title, url, id);
  }

  /** Move `id` into `parentId` at `index` (clamped), renumbering siblings. */
  move(id: number, parentId: number, index: number): void {
    const b = this.get(id);
    if (!b || b.parent_id === null) return;
    this.assertFolder(parentId);
    if (b.type === 'folder' && (parentId === id || this.descendantIds(id).includes(parentId))) {
      throw new Error('不能把文件夹移到它自己里面');
    }
    const siblings = this.children(parentId).filter((s) => s.id !== id);
    siblings.splice(Math.max(0, Math.min(index, siblings.length)), 0, b);
    this.store.batch([
      { sql: 'UPDATE bookmarks SET parent_id = ? WHERE id = ?', params: [parentId, id] },
      ...siblings.map((s, i) => ({ sql: 'UPDATE bookmarks SET position = ? WHERE id = ?', params: [i, s.id] })),
    ]);
  }

  /** Remove a bookmark, or a folder with everything in it. Roots can't be removed. */
  remove(id: number): void {
    const b = this.get(id);
    if (!b || b.parent_id === null) return;
    const ids = [id, ...this.descendantIds(id)];
    this.store.batch(ids.map((i) => ({ sql: 'DELETE FROM bookmarks WHERE id = ?', params: [i] })));
  }

  removeUrl(url: string): void {
    this.store.run('DELETE FROM bookmarks WHERE url = ? AND type = ?', url, 'link');
  }

  search(query: string, limit = 200): Bookmark[] {
    const like = `%${query.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    return this.store.all<Bookmark>(
      "SELECT * FROM bookmarks WHERE type = 'link' AND (title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\') ORDER BY created_at DESC LIMIT ?",
      like,
      like,
      limit,
    );
  }

  /**
   * Import a tree under `parentId` in one atomic write. Links whose URL already
   * exists in the same folder are skipped, so importing twice doesn't duplicate.
   */
  importTree(parentId: number, nodes: ImportNode[], at = Date.now()): { links: number; folders: number } {
    this.assertFolder(parentId);
    // Ids are assigned up front so the whole import is one deterministic batch.
    let nextId = (this.store.get<{ m: number }>('SELECT coalesce(max(id), 0) AS m FROM bookmarks')!.m ?? 0) + 1;
    const ops: Op[] = [];
    const counts = { links: 0, folders: 0 };

    const walk = (parent: number, list: ImportNode[], existing: Bookmark[]) => {
      let pos = existing.length ? Math.max(...existing.map((e) => e.position)) + 1 : 0;
      const seenUrls = new Set(existing.filter((e) => e.type === 'link').map((e) => e.url));
      const folders = new Map(existing.filter((e) => e.type === 'folder').map((e) => [e.title, e.id]));
      for (const n of list) {
        if (n.type === 'link') {
          if (seenUrls.has(n.url)) continue;
          seenUrls.add(n.url);
          ops.push({
            sql: 'INSERT INTO bookmarks (id, parent_id, type, title, url, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            params: [nextId++, parent, 'link', n.title || n.url, n.url, pos++, at],
          });
          counts.links++;
        } else {
          // Merge into a same-named folder that already exists, so re-imports stay tidy.
          let folderId = folders.get(n.title);
          let children: Bookmark[] = [];
          if (folderId !== undefined) {
            children = this.children(folderId);
          } else {
            folderId = nextId++;
            folders.set(n.title, folderId);
            ops.push({
              sql: 'INSERT INTO bookmarks (id, parent_id, type, title, url, position, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)',
              params: [folderId, parent, 'folder', n.title || '文件夹', pos++, at],
            });
            counts.folders++;
          }
          walk(folderId, n.children, children);
        }
      }
    };
    walk(parentId, nodes, this.children(parentId));
    this.store.batch(ops);
    return counts;
  }

  private descendantIds(id: number): number[] {
    return this.store
      .all<{ id: number }>(
        `WITH RECURSIVE d(id) AS (SELECT id FROM bookmarks WHERE parent_id = ?
           UNION ALL SELECT b.id FROM bookmarks b JOIN d ON b.parent_id = d.id) SELECT id FROM d`,
        id,
      )
      .map((r) => r.id);
  }

  private nextPosition(parentId: number): number {
    return this.store.get<{ p: number }>('SELECT coalesce(max(position) + 1, 0) AS p FROM bookmarks WHERE parent_id = ?', parentId)!.p;
  }

  private assertFolder(id: number): void {
    if (this.get(id)?.type !== 'folder') throw new Error('目标不是文件夹');
  }
}
