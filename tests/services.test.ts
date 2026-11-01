import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BAR_ID, BOOKMARKS_SCHEMA, BookmarkService, OTHER_ID } from '../src/main/bookmarks';
import { randomKey } from '../src/main/crypto';
import { HISTORY_SCHEMA, HistoryService, visitsToCsv } from '../src/main/history';
import { PASSWORDS_SCHEMA, PasswordService } from '../src/main/passwords';
import { EncryptedStore } from '../src/main/store';

const store = (schema: string) => EncryptedStore.open(mkdtempSync(join(tmpdir(), 'minb-svc-')), 's', randomKey(), schema);

describe('HistoryService', () => {
  const visit = (url: string, title: string, at: number) =>
    ({ url, title, at, transition: 'link' as const, referrerId: null, tabId: 1 });

  it('records, searches (incl. Chinese and short queries), and deletes', () => {
    const h = new HistoryService(store(HISTORY_SCHEMA));
    const a = h.add(visit('https://a.com/x', '隐私浏览器介绍', 1000));
    h.add(visit('https://b.org/', 'Bread recipes', 2000));
    h.add(visit('https://go.dev/', 'Go', 3000));
    expect(h.search().map((v) => v.url)).toEqual(['https://go.dev/', 'https://b.org/', 'https://a.com/x']);
    expect(h.search({ query: '浏览器' }).map((v) => v.id)).toEqual([a]);
    expect(h.search({ query: 'recipe' }).map((v) => v.title)).toEqual(['Bread recipes']);
    expect(h.search({ query: 'Go' }).map((v) => v.title)).toEqual(['Go']);
    expect(h.search({ before: 2000 }).map((v) => v.id)).toEqual([a]);
    h.setTitle(a, 'Renamed page');
    expect(h.search({ query: 'Renamed' }).map((v) => v.id)).toEqual([a]);
    expect(h.search({ query: '浏览器' })).toEqual([]);
    h.delete([a]);
    expect(h.count()).toBe(2);
    expect(h.deleteSince(2500)).toBe(1);
    expect(h.deleteSince(0)).toBe(1);
    expect(h.count()).toBe(0);
  });

  it('exports CSV with escaping', () => {
    const h = new HistoryService(store(HISTORY_SCHEMA));
    h.add(visit('https://a.com/?q=1,2', 'Say "hi"', 0));
    const csv = visitsToCsv(h.all());
    expect(csv.split('\n')[0]).toBe('id,visited_at,url,title,duration_ms,transition,referrer_id,tab_id,visited_at_iso');
    expect(csv).toContain('"https://a.com/?q=1,2","Say ""hi"""');
  });
});

describe('BookmarkService', () => {
  it('has the two roots and manages links and folders', () => {
    const b = new BookmarkService(store(BOOKMARKS_SCHEMA));
    expect(b.tree().map((n) => n.title)).toEqual(['收藏夹栏', '其他收藏']);
    const l1 = b.addLink(BAR_ID, 'One', 'https://one.com/');
    const f = b.addFolder(BAR_ID, 'Work');
    const l2 = b.addLink(f, 'Two', 'https://two.com/');
    expect(b.isBookmarked('https://two.com/')).toBe(true);
    b.move(l1, f, 0);
    expect(b.children(f).map((x) => x.id)).toEqual([l1, l2]);
    expect(() => b.move(f, f, 0)).toThrow();
    b.update(l2, { title: 'Second' });
    expect(b.get(l2)!.title).toBe('Second');
    b.remove(f);
    expect(b.children(BAR_ID)).toEqual([]);
    expect(b.isBookmarked('https://one.com/')).toBe(false);
    b.remove(BAR_ID); // roots are protected
    expect(b.get(BAR_ID)).toBeDefined();
  });

  it('imports a tree atomically and skips duplicates on re-import', () => {
    const s = store(BOOKMARKS_SCHEMA);
    const b = new BookmarkService(s);
    const tree = [
      { type: 'link' as const, title: 'A', url: 'https://a.com/' },
      { type: 'folder' as const, title: 'Dev', children: [{ type: 'link' as const, title: 'MDN', url: 'https://mdn.dev/' }] },
    ];
    expect(b.importTree(OTHER_ID, tree)).toEqual({ links: 2, folders: 1 });
    expect(b.importTree(OTHER_ID, tree)).toEqual({ links: 0, folders: 0 });
    const other = b.tree()[1];
    expect(other.children!.map((c) => c.title)).toEqual(['A', 'Dev']);
    expect(other.children![1].children!.map((c) => c.title)).toEqual(['MDN']);
  });
});

describe('PasswordService', () => {
  it('saves, updates, and binds passwords to their site', () => {
    const s = store(PASSWORDS_SCHEMA);
    const p = new PasswordService(s, randomKey());
    const id = p.save('https://a.com', 'me', 'pw1');
    expect(p.password(id)).toBe('pw1');
    expect(p.save('https://a.com', 'me', 'pw2')).toBe(id);
    expect(p.password(id)).toBe('pw2');
    expect(p.matches('https://a.com', 'me', 'pw2')).toBe(true);
    expect(p.forOrigin('https://b.com')).toEqual([]);
    // Moving the ciphertext to another site's row must not decrypt.
    const other = p.save('https://evil.com', 'me', 'x');
    const enc = s.get<{ password_enc: string }>('SELECT password_enc FROM credentials WHERE id = ?', id)!.password_enc;
    s.run('UPDATE credentials SET password_enc = ? WHERE id = ?', enc, other);
    expect(() => p.password(other)).toThrow();
    p.update(id, { username: 'me2' });
    expect(p.password(id)).toBe('pw2');
    // The login saved most recently is offered first.
    p.markUsed(id, Date.now() + 1000);
    const newer = p.save('https://a.com', 'second', 'pw', Date.now() + 2000);
    expect(p.forOrigin('https://a.com')[0].id).toBe(newer);
    p.remove(newer);
    p.setNeverSave('https://x.com', true);
    expect(p.isNeverSave('https://x.com')).toBe(true);
    p.remove(id);
    expect(p.get(id)).toBeUndefined();
  });
});

describe('bookmark descriptions', () => {
  const OLD_SCHEMA = `CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY, parent_id INTEGER, type TEXT NOT NULL, title TEXT NOT NULL, url TEXT,
    position INTEGER NOT NULL, created_at INTEGER NOT NULL);
    INSERT OR IGNORE INTO bookmarks VALUES (1, NULL, 'folder', '收藏夹栏', NULL, 0, 0);
    INSERT OR IGNORE INTO bookmarks VALUES (2, NULL, 'folder', '其他收藏', NULL, 1, 0);
    INSERT OR IGNORE INTO bookmarks VALUES (3, 1, 'link', 'Old', 'https://old.example/', 0, 0);`;

  it('adds the column to an existing database, also when recovering from the journal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'minb-mig-'));
    const key = randomKey();
    const open = (schema: string) => EncryptedStore.open(dir, 'b', Buffer.from(key), schema);
    open(OLD_SCHEMA).close(); // a database from the previous version

    const s = open(BOOKMARKS_SCHEMA);
    const b = new BookmarkService(s);
    expect(b.get(3)!.description).toBe('');
    b.addLink(BAR_ID, 'New', 'https://new.example/', 1, '新的描述');
    // no close(): the ALTER and the insert only exist in the journal
    const b2 = new BookmarkService(open(BOOKMARKS_SCHEMA));
    expect(b2.children(BAR_ID).map((x) => [x.title, x.description])).toEqual([['Old', ''], ['New', '新的描述']]);
  });

  it('stores, edits, and searches descriptions', () => {
    const b = new BookmarkService(store(BOOKMARKS_SCHEMA));
    const id = b.addLink(BAR_ID, 'Khan', 'https://khanacademy.org/', 1, '免费数学课程');
    expect(b.search('数学').map((x) => x.id)).toEqual([id]);
    b.update(id, { description: '免费课程' });
    expect(b.get(id)!.description).toBe('免费课程');
    b.update(id, { title: 'Khan Academy' });
    expect(b.get(id)!.description).toBe('免费课程');
  });

  it('imports descriptions and fills them in on re-import', () => {
    const b = new BookmarkService(store(BOOKMARKS_SCHEMA));
    b.importTree(OTHER_ID, [{ type: 'link', title: 'A', url: 'https://a.com/' }]);
    b.importTree(OTHER_ID, [
      { type: 'link', title: 'A', url: 'https://a.com/', description: '描述 A' },
      { type: 'link', title: 'B', url: 'https://b.com/', description: '描述 B' },
    ]);
    expect(b.children(OTHER_ID).map((x) => [x.title, x.description])).toEqual([['A', '描述 A'], ['B', '描述 B']]);
  });
});

describe('moving and removing several bookmarks', () => {
  it('moves a selection keeping its order, at the given index', () => {
    const b = new BookmarkService(store(BOOKMARKS_SCHEMA));
    const [a, c, d, e] = ['a', 'c', 'd', 'e'].map((t) => b.addLink(BAR_ID, t, `https://${t}.com/`));
    const f = b.addFolder(OTHER_ID, 'F');
    const x = b.addLink(f, 'x', 'https://x.com/');
    b.moveMany([e, a], f, 0); // order follows the list given
    expect(b.children(f).map((n) => n.title)).toEqual(['e', 'a', 'x']);
    expect(b.children(BAR_ID).map((n) => n.title)).toEqual(['c', 'd']);
    b.moveMany([c], BAR_ID, 5); // past the end clamps
    expect(b.children(BAR_ID).map((n) => n.title)).toEqual(['d', 'c']);
    b.moveMany([x, d], f, 1);
    expect(b.children(f).map((n) => n.title)).toEqual(['e', 'x', 'd', 'a']);
  });

  it('refuses to move a folder into itself or a descendant, changing nothing', () => {
    const b = new BookmarkService(store(BOOKMARKS_SCHEMA));
    const outer = b.addFolder(BAR_ID, 'outer');
    const inner = b.addFolder(outer, 'inner');
    const link = b.addLink(BAR_ID, 'l', 'https://l.com/');
    expect(() => b.moveMany([link, outer], inner, 0)).toThrow();
    expect(b.get(link)!.parent_id).toBe(BAR_ID);
  });

  it('removes a selection including folder contents, but never roots', () => {
    const b = new BookmarkService(store(BOOKMARKS_SCHEMA));
    const f = b.addFolder(BAR_ID, 'f');
    const inside = b.addLink(f, 'in', 'https://in.com/');
    const out = b.addLink(BAR_ID, 'out', 'https://out.com/');
    const keep = b.addLink(BAR_ID, 'keep', 'https://keep.com/');
    b.removeMany([f, out, BAR_ID]);
    expect(b.get(inside)).toBeUndefined();
    expect(b.children(BAR_ID).map((n) => n.id)).toEqual([keep]);
    expect(b.get(BAR_ID)).toBeDefined();
  });
});

describe('SessionService', () => {
  it('saves and restores open tabs, also after a crash', async () => {
    const { SESSION_SCHEMA, SessionService } = await import('../src/main/session');
    const dir = mkdtempSync(join(tmpdir(), 'minb-session-'));
    const key = randomKey();
    const open = () => EncryptedStore.open(dir, 'session', Buffer.from(key), SESSION_SCHEMA);
    const s = new SessionService(open());
    expect(s.load()).toEqual({ tabs: [], activeIndex: 0, split: null });
    const tabs = [
      { url: 'https://a.com/', title: 'A' },
      { url: 'min://history/', title: '历史记录' },
      { url: 'https://c.com/x', title: 'C' },
    ];
    const split = { first: 0, second: 2, orientation: 'vertical' as const, ratio: 0.4 };
    s.save({ tabs, activeIndex: 2, split });
    // no close(): the process "crashed"
    const s2 = new SessionService(open());
    expect(s2.load()).toEqual({ tabs, activeIndex: 2, split });
    s2.clear();
    expect(new SessionService(open()).load().tabs).toEqual([]);
  });

  it('skips writing when nothing changed', async () => {
    const { SESSION_SCHEMA, SessionService } = await import('../src/main/session');
    const st = store(SESSION_SCHEMA);
    const s = new SessionService(st);
    s.save({ tabs: [{ url: 'https://a.com/', title: 'A' }], activeIndex: 0 });
    const size = st.journalSize;
    s.save({ tabs: [{ url: 'https://a.com/', title: 'A' }], activeIndex: 0 });
    expect(st.journalSize).toBe(size);
  });
});
