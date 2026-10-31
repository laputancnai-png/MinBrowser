import { EncryptedStore, Op } from './store';

export const BAR_ID = 1;
export const OTHER_ID = 2;

export interface Bookmark {
  id: number;
  parent_id: number | null;
  type: 'folder' | 'link';
  title: string;
  url: string | null;
  description: string;
  position: number;
  created_at: number;
}

export interface BookmarkNode extends Bookmark {
  children?: BookmarkNode[];
}

/** A tree to import, e.g. parsed from Chrome. */
export type ImportNode =
  | { type: 'link'; title: string; url: string; description?: string }
  | { type: 'folder'; title: string; children: ImportNode[] };

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
INSERT OR IGNORE INTO bookmarks (id, parent_id, type, title, url, position, created_at) VALUES (${BAR_ID}, NULL, 'folder', '收藏夹栏', NULL, 0, 0);
INSERT OR IGNORE INTO bookmarks (id, parent_id, type, title, url, position, created_at) VALUES (${OTHER_ID}, NULL, 'folder', '其他收藏', NULL, 1, 0);
`;

export class BookmarkService {
  constructor(private readonly store: EncryptedStore) {
    // Added after the first release. The ALTER goes through the journal, so a
    // replay against an older snapshot adds the column at the same point.
    const columns = store.all<{ name: string }>("SELECT name FROM pragma_table_info('bookmarks')").map((c) => c.name);
    if (!columns.includes('description')) {
      store.run("ALTER TABLE bookmarks ADD COLUMN description TEXT NOT NULL DEFAULT ''");
    }
  }

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

  /** The first bookmark for this exact URL, if any. */
  findByUrl(url: string): Bookmark | undefined {
    return this.store.get<Bookmark>("SELECT * FROM bookmarks WHERE url = ? AND type = 'link' ORDER BY id LIMIT 1", url);
  }

  /** Every folder, depth-first in display order, with its nesting depth. */
  folderList(): { id: number; title: string; depth: number }[] {
    const out: { id: number; title: string; depth: number }[] = [];
    const walk = (nodes: BookmarkNode[], depth: number) => {
      for (const n of nodes) {
        if (n.type !== 'folder') continue;
        out.push({ id: n.id, title: n.title, depth });
        walk(n.children ?? [], depth + 1);
      }
    };
    walk(this.tree(), 0);
    return out;
  }

  isBookmarked(url: string): boolean {
    return this.store.get('SELECT 1 FROM bookmarks WHERE url = ? LIMIT 1', url) !== undefined;
  }

  addLink(parentId: number, title: string, url: string, at = Date.now(), description = ''): number {
    this.assertFolder(parentId);
    return this.store.run(
      'INSERT INTO bookmarks (parent_id, type, title, url, description, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      parentId,
      'link',
      title || url,
      url,
      description.trim(),
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

  update(id: number, patch: { title?: string; url?: string; description?: string }): void {
    const b = this.get(id);
    if (!b || b.parent_id === null) return;
    const title = patch.title?.trim() || b.title;
    const url = b.type === 'link' ? patch.url?.trim() || b.url : null;
    const description = patch.description === undefined ? b.description : patch.description.trim();
    this.store.run('UPDATE bookmarks SET title = ?, url = ?, description = ? WHERE id = ?', title, url, description, id);
  }

  /** Move `id` into `parentId` at `index` (clamped), renumbering siblings. */
  move(id: number, parentId: number, index: number): void {
    this.moveMany([id], parentId, index);
  }

  /**
   * Move several items into `parentId`, keeping their relative order, so they
   * land at `index` among the folder's other children. One atomic write.
   */
  moveMany(ids: number[], parentId: number, index: number): void {
    this.assertFolder(parentId);
    const moving = [...new Set(ids)].map((id) => this.get(id)).filter((b): b is Bookmark => !!b && b.parent_id !== null);
    if (moving.length === 0) return;
    for (const b of moving) {
      if (b.type === 'folder' && (parentId === b.id || this.descendantIds(b.id).includes(parentId))) {
        throw new Error('不能把文件夹移到它自己里面');
      }
    }
    const movingIds = new Set(moving.map((b) => b.id));
    const siblings = this.children(parentId).filter((s) => !movingIds.has(s.id));
    siblings.splice(Math.max(0, Math.min(index, siblings.length)), 0, ...moving);
    this.store.batch([
      ...moving.map((b) => ({ sql: 'UPDATE bookmarks SET parent_id = ? WHERE id = ?', params: [parentId, b.id] })),
      ...siblings.map((s, i) => ({ sql: 'UPDATE bookmarks SET position = ? WHERE id = ?', params: [i, s.id] })),
    ]);
  }

  /** Remove a bookmark, or a folder with everything in it. Roots can't be removed. */
  remove(id: number): void {
    this.removeMany([id]);
  }

  /** Remove several items (folders with their contents) in one atomic write. */
  removeMany(ids: number[]): void {
    const all = new Set<number>();
    for (const id of ids) {
      const b = this.get(id);
      if (!b || b.parent_id === null) continue;
      all.add(id);
      for (const d of this.descendantIds(id)) all.add(d);
    }
    this.store.batch([...all].map((i) => ({ sql: 'DELETE FROM bookmarks WHERE id = ?', params: [i] })));
  }

  removeUrl(url: string): void {
    this.store.run('DELETE FROM bookmarks WHERE url = ? AND type = ?', url, 'link');
  }

  search(query: string, limit = 200): Bookmark[] {
    const like = `%${query.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    return this.store.all<Bookmark>(
      "SELECT * FROM bookmarks WHERE type = 'link' AND (title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\') ORDER BY created_at DESC LIMIT ?",
      like,
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
      const seenUrls = new Map(existing.filter((e) => e.type === 'link').map((e) => [e.url, e]));
      const folders = new Map(existing.filter((e) => e.type === 'folder').map((e) => [e.title, e.id]));
      for (const n of list) {
        if (n.type === 'link') {
          const description = n.description?.trim() ?? '';
          const known = seenUrls.get(n.url);
          if (known) {
            // Already there: only fill in a description it didn't have yet.
            if (description && !known.description && known.id > 0) {
              ops.push({ sql: 'UPDATE bookmarks SET description = ? WHERE id = ?', params: [description, known.id] });
              known.description = description;
            }
            continue;
          }
          seenUrls.set(n.url, { id: -1, description } as Bookmark);
          ops.push({
            sql: 'INSERT INTO bookmarks (id, parent_id, type, title, url, description, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            params: [nextId++, parent, 'link', n.title || n.url, n.url, description, pos++, at],
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
