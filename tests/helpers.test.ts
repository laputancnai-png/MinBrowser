import { describe, expect, it } from 'vitest';
import { parseBookmarksHtml, parseChromeBookmarksJson } from '../src/main/chrome-import';
import { generatePassword, passwordStrength } from '../src/shared/password';
import { cleanUrlForHistory, originOf } from '../src/shared/url';

describe('cleanUrlForHistory', () => {
  it('strips tracking parameters and secrets', () => {
    expect(cleanUrlForHistory('https://a.com/p?utm_source=x&id=5&fbclid=y&gclid=z')).toBe('https://a.com/p?id=5');
    expect(cleanUrlForHistory('https://a.com/cb?access_token=abc&state=1')).toBe('https://a.com/cb?state=1');
    expect(cleanUrlForHistory('https://a.com/cb#access_token=abc')).toBe('https://a.com/cb');
    expect(cleanUrlForHistory('https://user:pass@a.com/')).toBe('https://a.com/');
    expect(cleanUrlForHistory('https://a.com/#section')).toBe('https://a.com/#section');
  });

  it('does not record non-web URLs', () => {
    expect(cleanUrlForHistory('min://newtab/')).toBeNull();
    expect(cleanUrlForHistory('file:///etc/passwd')).toBeNull();
  });

  it('computes origins', () => {
    expect(originOf('https://a.com:8443/x?y')).toBe('https://a.com:8443');
    expect(originOf('min://history/')).toBeNull();
  });
});

describe('generatePassword', () => {
  it('has the requested length and every character class', () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword(20);
      expect(p).toHaveLength(20);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/\d/);
      expect(p).toMatch(/[!@#$%^&*\-_=+?]/);
      expect(p).not.toMatch(/[lIO01]/);
    }
    expect(new Set(Array.from({ length: 100 }, () => generatePassword())).size).toBe(100);
  });

  it('rates passwords', () => {
    expect(passwordStrength('short')).toBe(0);
    expect(passwordStrength('aaaaaaaa')).toBe(1);
    expect(passwordStrength('Tr0ub4dor&3-horse-staple')).toBe(4);
  });
});

describe('Chrome import', () => {
  it('parses the Bookmarks JSON file', () => {
    const json = JSON.stringify({
      roots: {
        bookmark_bar: { children: [{ type: 'url', name: 'GitHub', url: 'https://github.com/' }, { type: 'url', name: 'JS', url: 'javascript:alert(1)' }] },
        other: { children: [{ type: 'folder', name: 'Read', children: [{ type: 'url', name: 'HN', url: 'https://news.ycombinator.com/' }] }] },
        synced: { children: [{ type: 'url', name: 'M', url: 'https://m.com/' }] },
      },
    });
    const r = parseChromeBookmarksJson(json);
    expect(r.bar).toEqual([{ type: 'link', title: 'GitHub', url: 'https://github.com/' }]);
    expect(r.other.map((n) => n.title)).toEqual(['Read', '移动设备书签']);
  });

  it('reads <DD> descriptions', () => {
    const html = `<DL><p><DT><A HREF="https://a.com/">A</A>
<DD>第一个 &amp; 描述
<DT><A HREF="https://b.com/">B</A>
<DT><H3>F</H3><DD>folder note
<DL><p><DT><A HREF="https://c.com/">C</A><DD>C 的描述</DL><p></DL>`;
    const r = parseBookmarksHtml(html);
    expect(r.other).toEqual([
      { type: 'link', title: 'A', url: 'https://a.com/', description: '第一个 & 描述' },
      { type: 'link', title: 'B', url: 'https://b.com/' },
      { type: 'folder', title: 'F', children: [{ type: 'link', title: 'C', url: 'https://c.com/', description: 'C 的描述' }] },
    ]);
  });

  it('parses the bookmarks.html export', () => {
    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3 ADD_DATE="1" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
  <DL><p>
    <DT><A HREF="https://a.com/?x=1&amp;y=2">A &amp; B</A>
    <DT><H3>Sub</H3>
    <DL><p><DT><A HREF="https://c.com/">C</A></DL><p>
  </DL><p>
  <DT><A HREF="https://other.com/">Other</A>
</DL><p>`;
    const r = parseBookmarksHtml(html);
    expect(r.bar).toEqual([
      { type: 'link', title: 'A & B', url: 'https://a.com/?x=1&y=2' },
      { type: 'folder', title: 'Sub', children: [{ type: 'link', title: 'C', url: 'https://c.com/' }] },
    ]);
    expect(r.other).toEqual([{ type: 'link', title: 'Other', url: 'https://other.com/' }]);
  });
});
