import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './fsutil';

/** Non-sensitive settings, stored in plain JSON inside the data folder. */
export interface Config {
  recordingPaused: boolean;
  autoLockMinutes: number; // 0 = never
  downloadDir: string | null; // null = system Downloads folder
  askDownloadLocation: boolean;
  clearCookiesOnExit: boolean;
  adblockEnabled: boolean;
  adblockUpdatedAt: number | null;
  showBookmarksBar: boolean;
}

export const DEFAULT_CONFIG: Config = {
  recordingPaused: false,
  autoLockMinutes: 15,
  downloadDir: null,
  askDownloadLocation: false,
  clearCookiesOnExit: false,
  adblockEnabled: true,
  adblockUpdatedAt: null,
  showBookmarksBar: true,
};

export class ConfigStore {
  private value: Config;

  constructor(private readonly dir: string) {
    this.value = { ...DEFAULT_CONFIG };
    const path = join(dir, 'config.json');
    if (existsSync(path)) {
      try {
        const saved = JSON.parse(readFileSync(path, 'utf8'));
        for (const key of Object.keys(DEFAULT_CONFIG) as (keyof Config)[]) {
          if (!(key in saved)) continue;
          const fallback = DEFAULT_CONFIG[key];
          // Keep only values of the expected type; nullable settings accept anything JSON gave us.
          if (fallback === null || typeof saved[key] === typeof fallback) {
            (this.value as unknown as Record<string, unknown>)[key] = saved[key];
          }
        }
      } catch {
        // A corrupt config just falls back to defaults.
      }
    }
  }

  get(): Config {
    return { ...this.value };
  }

  set(patch: Partial<Config>): Config {
    this.value = { ...this.value, ...patch };
    writeFileAtomic(join(this.dir, 'config.json'), JSON.stringify(this.value, null, 2));
    return this.get();
  }
}

/**
 * The only thing stored outside the data folder: where the data folder is.
 * Lives in the app's default userData directory.
 */
export const location = {
  path: () => join(app.getPath('userData'), 'location.json'),
  read(): string | null {
    try {
      const { dataDir } = JSON.parse(readFileSync(this.path(), 'utf8'));
      return typeof dataDir === 'string' ? dataDir : null;
    } catch {
      return null;
    }
  },
  write(dataDir: string): void {
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileAtomic(this.path(), JSON.stringify({ dataDir }, null, 2));
  },
};
