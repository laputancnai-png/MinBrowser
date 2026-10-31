import { EncryptedStore } from './store';

export const SITES_SCHEMA = `
CREATE TABLE IF NOT EXISTS adblock_allow (site TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
`;

/**
 * Per-site preferences. Kept encrypted because a list of sites is itself
 * browsing history.
 */
export class SiteService {
  private allow = new Set<string>();

  constructor(private readonly store: EncryptedStore) {
    for (const r of store.all<{ site: string }>('SELECT site FROM adblock_allow')) this.allow.add(r.site);
  }

  adblockAllowed(site: string): boolean {
    return this.allow.has(site);
  }

  setAdblockAllowed(site: string, allowed: boolean, at = Date.now()): void {
    if (allowed) {
      this.store.run('INSERT OR IGNORE INTO adblock_allow (site, created_at) VALUES (?, ?)', site, at);
      this.allow.add(site);
    } else {
      this.store.run('DELETE FROM adblock_allow WHERE site = ?', site);
      this.allow.delete(site);
    }
  }

  adblockAllowList(): string[] {
    return [...this.allow].sort();
  }
}
