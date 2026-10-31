import { describe, expect, it } from 'vitest';
import { cleanUserAgent, isThirdParty, siteOf } from '../src/shared/privacy';

describe('siteOf', () => {
  it('returns the registrable domain', () => {
    expect(siteOf('https://news.bbc.co.uk/x')).toBe('bbc.co.uk');
    expect(siteOf('https://a.b.example.com')).toBe('example.com');
    expect(siteOf('http://localhost:3000')).toBe('localhost');
    expect(siteOf('not a url')).toBeNull();
  });
});

describe('isThirdParty', () => {
  it('treats subdomains of the same site as first-party', () => {
    expect(isThirdParty('https://cdn.example.com/a.js', 'https://www.example.com/')).toBe(false);
  });

  it('flags other sites as third-party', () => {
    expect(isThirdParty('https://tracker.net/p.gif', 'https://www.example.com/')).toBe(true);
  });

  it('separates different users on shared hosting', () => {
    expect(isThirdParty('https://alice.github.io/', 'https://bob.github.io/')).toBe(true);
  });

  it('does not flag when the page URL is unknown', () => {
    expect(isThirdParty('https://tracker.net/', 'min://newtab/')).toBe(false);
  });
});

describe('cleanUserAgent', () => {
  it('removes Electron and app tokens', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) minbrowser/0.1.0 Chrome/140.0.0.0 Electron/45.2.1 Safari/537.36';
    expect(cleanUserAgent(ua)).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    );
  });
});
