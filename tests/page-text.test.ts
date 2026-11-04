import { describe, expect, it } from 'vitest';
import { looksChinese } from '../src/shared/page-text';

describe('looksChinese', () => {
  it('says an English page is not Chinese, even with some Chinese in it', () => {
    expect(looksChinese('The quick brown fox jumps over the lazy dog. '.repeat(20) + '中文导航')).toBe(false);
  });
  it('says a Chinese page with English menus is Chinese', () => {
    expect(looksChinese('首页 Home 关于我们 About 这是一个关于隐私浏览器的中文网页，内容很多很多。'.repeat(10))).toBe(true);
  });
  it('treats a page without English as nothing to translate', () => {
    expect(looksChinese('12345 !!! ???')).toBe(true);
  });
});
