import { open, seal } from './crypto';
import { EncryptedStore } from './store';

export interface Credential {
  id: number;
  origin: string;
  username: string;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

export const PASSWORDS_SCHEMA = `
CREATE TABLE IF NOT EXISTS credentials (
  id INTEGER PRIMARY KEY,
  origin TEXT NOT NULL,
  username TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS credentials_login ON credentials(origin, username);
CREATE TABLE IF NOT EXISTS never_save (origin TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
`;

const COLUMNS = 'id, origin, username, created_at, updated_at, last_used_at';

/**
 * Saved logins. The database file is encrypted as a whole, and on top of that
 * each password is sealed with its own key, bound to its origin and username,
 * so a password can never be decrypted for a different site.
 */
export class PasswordService {
  constructor(
    private readonly store: EncryptedStore,
    private readonly entryKey: Buffer,
  ) {}

  list(): Credential[] {
    return this.store.all<Credential>(`SELECT ${COLUMNS} FROM credentials ORDER BY origin, username`);
  }

  forOrigin(origin: string): Credential[] {
    return this.store.all<Credential>(
      `SELECT ${COLUMNS} FROM credentials WHERE origin = ? ORDER BY last_used_at DESC NULLS LAST, username`,
      origin,
    );
  }

  get(id: number): Credential | undefined {
    return this.store.get<Credential>(`SELECT ${COLUMNS} FROM credentials WHERE id = ?`, id);
  }

  find(origin: string, username: string): Credential | undefined {
    return this.store.get<Credential>(`SELECT ${COLUMNS} FROM credentials WHERE origin = ? AND username = ?`, origin, username);
  }

  password(id: number): string {
    const row = this.store.get<{ origin: string; username: string; password_enc: string }>(
      'SELECT origin, username, password_enc FROM credentials WHERE id = ?',
      id,
    );
    if (!row) throw new Error('找不到这条密码');
    return open(this.entryKey, Buffer.from(row.password_enc, 'base64'), aad(row.origin, row.username)).toString('utf8');
  }

  /** Insert or update the login for (origin, username). */
  save(origin: string, username: string, password: string, at = Date.now()): number {
    const enc = this.encrypt(origin, username, password);
    const existing = this.find(origin, username);
    // Saving a login means it was just used: it becomes the one filled first.
    if (existing) {
      this.store.run('UPDATE credentials SET password_enc = ?, updated_at = ?, last_used_at = ? WHERE id = ?', enc, at, at, existing.id);
      return existing.id;
    }
    return this.store.run(
      'INSERT INTO credentials (origin, username, password_enc, created_at, updated_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)',
      origin,
      username,
      enc,
      at,
      at,
      at,
    ).lastInsertRowid;
  }

  update(id: number, patch: { username?: string; password?: string }, at = Date.now()): void {
    const cur = this.get(id);
    if (!cur) throw new Error('找不到这条密码');
    const username = patch.username ?? cur.username;
    if (username !== cur.username && this.find(cur.origin, username)) throw new Error('这个网站已经保存了同名账号');
    const password = patch.password ?? this.password(id);
    this.store.run(
      'UPDATE credentials SET username = ?, password_enc = ?, updated_at = ? WHERE id = ?',
      username,
      this.encrypt(cur.origin, username, password),
      at,
      id,
    );
  }

  markUsed(id: number, at = Date.now()): void {
    this.store.run('UPDATE credentials SET last_used_at = ? WHERE id = ?', at, id);
  }

  remove(id: number): void {
    this.store.run('DELETE FROM credentials WHERE id = ?', id);
  }

  /** True if this exact login is already stored. */
  matches(origin: string, username: string, password: string): boolean {
    const c = this.find(origin, username);
    return !!c && this.password(c.id) === password;
  }

  neverSaveList(): string[] {
    return this.store.all<{ origin: string }>('SELECT origin FROM never_save ORDER BY origin').map((r) => r.origin);
  }

  isNeverSave(origin: string): boolean {
    return this.store.get('SELECT 1 FROM never_save WHERE origin = ?', origin) !== undefined;
  }

  setNeverSave(origin: string, never: boolean, at = Date.now()): void {
    if (never) this.store.run('INSERT OR IGNORE INTO never_save (origin, created_at) VALUES (?, ?)', origin, at);
    else this.store.run('DELETE FROM never_save WHERE origin = ?', origin);
  }

  close(): void {
    this.entryKey.fill(0);
  }

  private encrypt(origin: string, username: string, password: string): string {
    return seal(this.entryKey, Buffer.from(password, 'utf8'), aad(origin, username)).toString('base64');
  }
}

function aad(origin: string, username: string): Buffer {
  return Buffer.from(JSON.stringify(['credential', origin, username]));
}
