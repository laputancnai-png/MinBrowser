import { describe, expect, it } from 'vitest';
import { bookmarksToHtml, countLinks, parseBookmarksHtml } from '../src/main/chrome-import';
import type { BookmarkNode } from '../src/main/bookmarks';

let nextId = 10;
const link = (title: string, url: string, description = ''): BookmarkNode => ({
  id: nextId++, parent_id: null, type: 'link', title, url, description, position: 0, created_at: 1_700_000_000_000,
});
const folder = (id: number, title: string, children: BookmarkNode[]): BookmarkNode => ({
  id, parent_id: null, type: 'folder', title, url: null, description: '', position: 0, created_at: 0, children,
});

describe('bookmark export', () => {
  const bar = folder(1, '收藏夹栏', [
    link('News & "Views" <today>', 'https://example.com/?a=1&b=2', '每日新闻\n和评论 <b>'),
    folder(20, '工作', [link('文档', 'https://docs.example.com/'), folder(21, '空文件夹', [])]),
  ]);
  const other = folder(2, '其他收藏', [link('Other', 'https://other.example/'), folder(22, '阅读', [link('Blog', 'https://blog.example/')])]);
  const html = bookmarksToHtml(bar, other);

  it('writes the standard bookmarks.html format', () => {
    expect(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>')).toBe(true);
    expect(html).toContain('PERSONAL_TOOLBAR_FOLDER="true">收藏夹栏</H3>');
    expect(html).toContain('HREF="https://example.com/?a=1&amp;b=2" ADD_DATE="1700000000"');
    expect(html).not.toContain('<b>');
  });

  it('reads back exactly, with the bar, folders, titles and descriptions', () => {
    const parsed = parseBookmarksHtml(html);
    expect(parsed.bar).toEqual([
      { type: 'link', title: 'News & "Views" <today>', url: 'https://example.com/?a=1&b=2', description: '每日新闻 和评论 <b>' },
      { type: 'folder', title: '工作', children: [{ type: 'link', title: '文档', url: 'https://docs.example.com/' }, { type: 'folder', title: '空文件夹', children: [] }] },
    ]);
    expect(parsed.other).toEqual([
      { type: 'link', title: 'Other', url: 'https://other.example/' },
      { type: 'folder', title: '阅读', children: [{ type: 'link', title: 'Blog', url: 'https://blog.example/' }] },
    ]);
  });

  it('counts links in nested folders', () => {
    expect(countLinks([bar, other])).toBe(4);
  });
});
