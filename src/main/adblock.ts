import { FiltersEngine, Request } from '@ghostery/adblocker';
import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from './fsutil';

export const FILTER_LISTS = [
  'https://easylist.to/easylist/easylist.txt',
  'https://easylist.to/easylist/easyprivacy.txt',
];

/** Used until the full lists have been downloaded once, so blocking works from the first page. */
const BUILTIN_RULES = [
  '||google-analytics.com^',
  '||googletagmanager.com^',
  '||googletagservices.com^',
  '||doubleclick.net^',
  '||googlesyndication.com^',
  '||googleadservices.com^',
  '||adservice.google.com^',
  '||connect.facebook.net^',
  '||facebook.com/tr^',
  '||analytics.twitter.com^',
  '||static.ads-twitter.com^',
  '||ads.linkedin.com^',
  '||px.ads.linkedin.com^',
  '||bat.bing.com^',
  '||clarity.ms^',
  '||hotjar.com^',
  '||scorecardresearch.com^',
  '||quantserve.com^',
  '||criteo.com^',
  '||criteo.net^',
  '||taboola.com^',
  '||outbrain.com^',
  '||adnxs.com^',
  '||amazon-adsystem.com^',
  '||segment.io^',
  '||mixpanel.com^',
  '||hm.baidu.com^',
  '||cnzz.com^',
].join('\n');

const TYPES: Record<string, string> = {
  subFrame: 'sub_frame',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  object: 'object',
  xhr: 'xmlhttprequest',
  ping: 'ping',
  cspReport: 'csp_report',
  media: 'media',
  webSocket: 'websocket',
  other: 'other',
};

/**
 * Network-level ad and tracker blocking with EasyList + EasyPrivacy. The
 * compiled engine is cached on disk (it only contains the public lists).
 */
export class AdBlocker {
  private engine: FiltersEngine;
  private builtin: boolean;

  constructor(private readonly cacheFile: string) {
    if (existsSync(cacheFile)) {
      try {
        this.engine = FiltersEngine.deserialize(new Uint8Array(readFileSync(cacheFile)));
        this.builtin = false;
        return;
      } catch {
        // fall through to the built-in rules
      }
    }
    this.engine = FiltersEngine.parse(BUILTIN_RULES);
    this.builtin = true;
  }

  get usingBuiltinRules(): boolean {
    return this.builtin;
  }

  /** Whether a sub-resource request should be blocked. Navigations are never blocked. */
  shouldBlock(url: string, resourceType: string, pageUrl: string): boolean {
    const type = TYPES[resourceType];
    if (!type || !/^(https?|wss?):/.test(url)) return false;
    const { match } = this.engine.match(Request.fromRawDetails({ url, sourceUrl: pageUrl, type: type as never }));
    return match;
  }

  /** Download the lists and rebuild the engine. Returns the number of rules loaded. */
  async update(fetchText: (url: string) => Promise<string>): Promise<number> {
    const lists = await Promise.all(FILTER_LISTS.map(fetchText));
    const engine = FiltersEngine.parse(lists.join('\n'), { loadCosmeticFilters: false });
    writeFileAtomic(this.cacheFile, engine.serialize());
    this.engine = engine;
    this.builtin = false;
    return lists.reduce((n, l) => n + l.split('\n').filter((line) => line && !line.startsWith('!')).length, 0);
  }

  /** For tests: replace the rules. */
  static fromRules(rules: string, cacheFile: string): AdBlocker {
    const b = new AdBlocker(cacheFile);
    b.engine = FiltersEngine.parse(rules);
    b.builtin = false;
    return b;
  }
}
