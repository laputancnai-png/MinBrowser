import { describe, expect, it } from 'vitest';
import { displayUrl, NEW_TAB_URL, parseWebAddress, resolveInput, SEARCH_URL } from '../src/shared/url';

const searchFor = (q: string) => SEARCH_URL + encodeURIComponent(q);

describe('resolveInput', () => {
  it('returns null for empty input', () => {
    expect(resolveInput('   ')).toBeNull();
  });

  it('keeps full URLs with allowed schemes', () => {
    expect(resolveInput('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(resolveInput('http://example.com')).toBe('http://example.com/');
    expect(resolveInput('min://newtab/')).toBe('min://newtab/');
  });

  it('adds https to bare domains', () => {
    expect(resolveInput('example.com')).toBe('https://example.com/');
    expect(resolveInput('news.bbc.co.uk/sport')).toBe('https://news.bbc.co.uk/sport');
    expect(resolveInput('github.io')).toBe('https://github.io/');
  });

  it('uses http for localhost and IPs', () => {
    expect(resolveInput('localhost:3000')).toBe('http://localhost:3000/');
    expect(resolveInput('192.168.1.1')).toBe('http://192.168.1.1/');
    expect(resolveInput('127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/x');
  });

  it('searches for plain words and sentences', () => {
    expect(resolveInput('hello')).toBe(searchFor('hello'));
    expect(resolveInput('how to bake bread')).toBe(searchFor('how to bake bread'));
    expect(resolveInput('隐私 浏览器')).toBe(searchFor('隐私 浏览器'));
  });

  it('searches for things that only look like domains', () => {
    expect(resolveInput('file.notarealtld')).toBe(searchFor('file.notarealtld'));
    expect(resolveInput('node.js')).toBe(searchFor('node.js'));
  });

  it('never loads dangerous schemes', () => {
    expect(resolveInput('javascript:alert(1)')).toBe(searchFor('javascript:alert(1)'));
    expect(resolveInput('data:text/html,hi')).toBe(searchFor('data:text/html,hi'));
  });
});

describe('displayUrl', () => {
  it('hides internal new tab page', () => {
    expect(displayUrl(NEW_TAB_URL)).toBe('');
    expect(displayUrl('about:blank')).toBe('');
    expect(displayUrl('https://a.com/')).toBe('https://a.com/');
  });
});

describe('parseWebAddress', () => {
  it('takes what was typed as an address, never a search', () => {
    expect(parseWebAddress('bar2.example')).toBe('https://bar2.example/');
    expect(parseWebAddress('  example.com/a?b=1 ')).toBe('https://example.com/a?b=1');
    expect(parseWebAddress('http://site.test')).toBe('http://site.test/');
    expect(parseWebAddress('localhost:8080/x')).toBe('https://localhost:8080/x');
  });
  it('rejects anything that is not a web address', () => {
    for (const bad of ['', 'hello world', 'word', 'javascript:alert(1)', 'file:///etc/passwd', 'min://passwords/', 'data:text/html,x']) {
      expect(parseWebAddress(bad)).toBeNull();
    }
  });
});
