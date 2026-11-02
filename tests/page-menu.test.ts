import { describe, expect, it, vi } from 'vitest';
import { isOpenable, pageMenu, PageMenuActions } from '../src/main/page-menu';

const flags = { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: true, canSelectAll: true, canDelete: false, canEditRichly: false };
const base = { linkURL: '', srcURL: '', mediaType: 'none' as const, hasImageContents: false, selectionText: '', isEditable: false, editFlags: flags };
const state = { canGoBack: true, canGoForward: false };

function actions(): PageMenuActions {
  return {
    openInNewTab: vi.fn(),
    openInSplit: vi.fn(),
    copyText: vi.fn(),
    copyImage: vi.fn(),
    download: vi.fn(),
    search: vi.fn(),
    edit: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    reload: vi.fn(),
  };
}
const labels = (items: ReturnType<typeof pageMenu>) => items.map((i) => i.label ?? '---');
const click = (items: ReturnType<typeof pageMenu>, label: string) =>
  (items.find((i) => i.label === label)!.click as () => void)();

describe('page context menu', () => {
  it('offers to open a link in a new tab', () => {
    const a = actions();
    const items = pageMenu({ ...base, linkURL: 'https://example.com/a' }, state, a);
    expect(labels(items)).toEqual(['在新标签页中打开链接', '在分屏中打开链接', '复制链接地址', '链接另存为…']);
    click(items, '在新标签页中打开链接');
    expect(a.openInNewTab).toHaveBeenCalledWith('https://example.com/a');
    click(items, '在分屏中打开链接');
    expect(a.openInSplit).toHaveBeenCalledWith('https://example.com/a');
    click(items, '复制链接地址');
    expect(a.copyText).toHaveBeenCalledWith('https://example.com/a');
  });

  it('never opens non-web links in a tab', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'min://passwords/', 'data:text/html,hi']) {
      const items = pageMenu({ ...base, linkURL: url }, state, actions());
      expect(labels(items)).toEqual(['复制链接地址']);
    }
    expect(isOpenable('HTTP://EXAMPLE.COM')).toBe(true);
  });

  it('copies the address part of mailto links', () => {
    const a = actions();
    click(pageMenu({ ...base, linkURL: 'mailto:me@example.com' }, state, a), '复制链接地址');
    expect(a.copyText).toHaveBeenCalledWith('me@example.com');
  });

  it('has image items, and link items for a linked image', () => {
    const items = pageMenu({ ...base, linkURL: 'https://x.test/', mediaType: 'image', srcURL: 'https://x.test/i.png', hasImageContents: true }, state, actions());
    expect(labels(items)).toEqual([
      '在新标签页中打开链接', '在分屏中打开链接', '复制链接地址', '链接另存为…', '---',
      '在新标签页中打开图片', '图片另存为…', '复制图片', '复制图片地址',
    ]);
  });

  it('searches selected text with a short label', () => {
    const a = actions();
    const items = pageMenu({ ...base, selectionText: '  a very long piece of selected text & more  ' }, state, a);
    expect(labels(items)[1]).toBe('用 DuckDuckGo 搜索“a very long piece of sel…”');
    click(items, labels(items)[1]!);
    expect(a.search).toHaveBeenCalledWith('a very long piece of selected text & more');
  });

  it('has edit commands in text fields', () => {
    const a = actions();
    const items = pageMenu({ ...base, isEditable: true }, state, a);
    expect(labels(items)).toEqual(['撤销', '重做', '---', '剪切', '复制', '粘贴', '全选']);
    expect(items.find((i) => i.label === '撤销')!.enabled).toBe(false);
    expect(items.every((i) => !i.accelerator || i.registerAccelerator === false)).toBe(true);
    click(items, '粘贴');
    expect(a.edit).toHaveBeenCalledWith('paste');
  });

  it('falls back to page navigation', () => {
    const items = pageMenu(base, state, actions());
    expect(labels(items)).toEqual(['后退', '前进', '重新加载']);
    expect(items[1].enabled).toBe(false);
  });
});
