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
    p.setNeverSave('https://x.com', true);
    expect(p.isNeverSave('https://x.com')).toBe(true);
    p.remove(id);
    expect(p.get(id)).toBeUndefined();
  });
});
