import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveKey, KdfParams, newKdfParams, open, randomKey, seal, subkey } from './crypto';
import { writeFileAtomic } from './fsutil';

export const VAULT_FILE = 'vault.meta';
export const MIN_PASSWORD_LENGTH = 8;
const WRAP_AAD = Buffer.from('minbrowser:data-key:v1');

interface VaultMeta {
  version: 1;
  kdf: KdfParams;
  /** The data key, encrypted with the key derived from the master password. */
  wrappedKey: string;
  createdAt: number;
}

export class WrongPasswordError extends Error {
  constructor() {
    super('主密码不正确');
  }
}

/**
 * Holds the data key while unlocked. The master password is never stored;
 * it only unwraps the random data key that every database key derives from.
 */
export class Vault {
  private constructor(
    readonly dir: string,
    private dataKey: Buffer | null,
  ) {}

  static exists(dir: string): boolean {
    return existsSync(join(dir, VAULT_FILE));
  }

  static async create(dir: string, password: string): Promise<Vault> {
    if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`主密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符`);
    if (Vault.exists(dir)) throw new Error('这个文件夹里已经有 MinBrowser 数据');
    const dataKey = randomKey();
    await writeMeta(dir, password, dataKey);
    return new Vault(dir, dataKey);
  }

  static async unlock(dir: string, password: string): Promise<Vault> {
    const meta = readMeta(dir);
    const kek = await deriveKey(password, meta.kdf);
    try {
      return new Vault(dir, open(kek, Buffer.from(meta.wrappedKey, 'base64'), WRAP_AAD));
    } catch {
      throw new WrongPasswordError();
    } finally {
      kek.fill(0);
    }
  }

  get unlocked(): boolean {
    return this.dataKey !== null;
  }

  /** A key dedicated to one purpose, e.g. "db:history". Caller should zero it when done. */
  key(label: string): Buffer {
    if (!this.dataKey) throw new Error('vault is locked');
    return subkey(this.dataKey, label);
  }

  /** Re-wrap the same data key under a new password; no data needs re-encrypting. */
  async changePassword(current: string, next: string): Promise<void> {
    if (!this.dataKey) throw new Error('vault is locked');
    if (next.length < MIN_PASSWORD_LENGTH) throw new Error(`主密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符`);
    const check = await Vault.unlock(this.dir, current);
    check.lock();
    await writeMeta(this.dir, next, this.dataKey);
  }

  lock(): void {
    this.dataKey?.fill(0);
    this.dataKey = null;
  }
}

function readMeta(dir: string): VaultMeta {
  const meta = JSON.parse(readFileSync(join(dir, VAULT_FILE), 'utf8')) as VaultMeta;
  if (meta.version !== 1 || meta.kdf?.algorithm !== 'argon2id') throw new Error('无法识别的数据文件版本');
  return meta;
}

async function writeMeta(dir: string, password: string, dataKey: Buffer): Promise<void> {
  const kdf = newKdfParams();
  const kek = await deriveKey(password, kdf);
  try {
    const meta: VaultMeta = {
      version: 1,
      kdf,
      wrappedKey: seal(kek, dataKey, WRAP_AAD).toString('base64'),
      createdAt: Date.now(),
    };
    writeFileAtomic(join(dir, VAULT_FILE), JSON.stringify(meta, null, 2));
  } finally {
    kek.fill(0);
  }
}
