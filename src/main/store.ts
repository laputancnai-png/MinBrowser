import { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { open, seal } from './crypto';
import { writeFileAtomic } from './fsutil';

export type Param = string | number | null;
export interface Op {
  sql: string;
  params?: Param[];
}

const MAGIC = Buffer.from('MINBDB1\0');
const HEADER_LEN = MAGIC.length + 4;
const COMPACT_FRAMES = 1000;
const COMPACT_BYTES = 4 * 1024 * 1024;

/**
 * An SQLite database that only ever touches the disk encrypted.
 *
 * While unlocked the database lives in memory. On disk there are two files:
 *   <name>.db.enc         an encrypted snapshot of the whole database (generation N)
 *   <name>.<N>.journal    encrypted write operations made since that snapshot
 *
 * Every write is applied in memory and appended to the journal, so a crash
 * loses nothing that was acknowledged. Once the journal grows, or the store is
 * closed, a fresh snapshot is written (generation N+1) and the old journal is
 * deleted. Writes must be deterministic so replaying them reproduces the same
 * state: pass timestamps as parameters, never use random() or now() in SQL.
 */
export class EncryptedStore {
  private db: DatabaseSync;
  private gen = 0;
  private frames = 0;
  private journalBytes = 0;
  private closed = false;

  private constructor(
    private readonly dir: string,
    private readonly name: string,
    private readonly key: Buffer,
  ) {
    this.db = new DatabaseSync(':memory:');
  }

  /** `schema` runs on every open and must be idempotent (CREATE ... IF NOT EXISTS). */
  static open(dir: string, name: string, key: Buffer, schema: string): EncryptedStore {
    const store = new EncryptedStore(dir, name, key);
    store.load(schema);
    return store;
  }

  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    const [result] = this.batch([{ sql, params }]);
    return result;
  }

  /** Apply several writes atomically: all of them land, or none do. */
  batch(ops: Op[]): { changes: number; lastInsertRowid: number }[] {
    this.assertOpen();
    if (ops.length === 0) return [];
    for (const op of ops) for (const p of op.params ?? []) assertParam(p);
    const results = this.apply(ops);
    this.append(ops);
    if (this.frames >= COMPACT_FRAMES || this.journalBytes >= COMPACT_BYTES) this.compact();
    return results;
  }

  all<T>(sql: string, ...params: Param[]): T[] {
    this.assertOpen();
    return this.db.prepare(sql).all(...params) as T[];
  }

  get<T>(sql: string, ...params: Param[]): T | undefined {
    this.assertOpen();
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  /** Write a new snapshot and drop the journal. */
  compact(): void {
    this.assertOpen();
    const next = this.gen + 1;
    const header = Buffer.alloc(HEADER_LEN);
    MAGIC.copy(header);
    header.writeUInt32BE(next, MAGIC.length);
    const body = seal(this.key, this.db.serialize(), this.snapshotAad(next));
    writeFileAtomic(this.snapshotPath(), Buffer.concat([header, body]));
    const old = this.journalPath(this.gen);
    this.gen = next;
    this.frames = 0;
    this.journalBytes = 0;
    if (existsSync(old)) unlinkSync(old);
  }

  close(): void {
    if (this.closed) return;
    if (this.frames > 0 || !existsSync(this.snapshotPath())) this.compact();
    this.db.close();
    this.key.fill(0);
    this.closed = true;
  }

  private load(schema: string): void {
    const snapshot = this.snapshotPath();
    if (existsSync(snapshot)) {
      const file = readFileSync(snapshot);
      if (file.length < HEADER_LEN || !file.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new Error(`${this.name}: 不是有效的数据文件`);
      }
      this.gen = file.readUInt32BE(MAGIC.length);
      const plain = open(this.key, file.subarray(HEADER_LEN), this.snapshotAad(this.gen));
      this.db.deserialize(new Uint8Array(plain.buffer, plain.byteOffset, plain.byteLength));
      plain.fill(0);
    }
    this.db.exec(schema);
    this.replayJournal();
    this.removeStaleJournals();
  }

  private replayJournal(): void {
    const path = this.journalPath(this.gen);
    if (!existsSync(path)) return;
    const data = readFileSync(path);
    let off = 0;
    let index = 0;
    while (off + 4 <= data.length) {
      const len = data.readUInt32BE(off);
      if (off + 4 + len > data.length) break; // torn final write from a crash
      let ops: Op[];
      try {
        ops = JSON.parse(open(this.key, data.subarray(off + 4, off + 4 + len), this.frameAad(index)).toString('utf8'));
      } catch {
        break;
      }
      this.apply(ops);
      off += 4 + len;
      index++;
    }
    this.frames = index;
    this.journalBytes = off;
    // Anything after the last good frame is garbage; rewrite the journal without it.
    if (off !== data.length) writeFileAtomic(path, data.subarray(0, off));
  }

  private removeStaleJournals(): void {
    const prefix = `${this.name}.`;
    const keep = `${this.name}.${this.gen}.journal`;
    for (const f of readdirSync(this.dir)) {
      if (f.startsWith(prefix) && f.endsWith('.journal') && f !== keep) unlinkSync(join(this.dir, f));
    }
  }

  private apply(ops: Op[]): { changes: number; lastInsertRowid: number }[] {
    this.db.exec('BEGIN');
    try {
      const results = ops.map((op) => {
        const r = this.db.prepare(op.sql).run(...((op.params ?? []) as SQLInputValue[]));
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
      });
      this.db.exec('COMMIT');
      return results;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private append(ops: Op[]): void {
    const sealed = seal(this.key, Buffer.from(JSON.stringify(ops)), this.frameAad(this.frames));
    const frame = Buffer.alloc(4 + sealed.length);
    frame.writeUInt32BE(sealed.length, 0);
    sealed.copy(frame, 4);
    appendFileSync(this.journalPath(this.gen), frame, { mode: 0o600 });
    this.frames++;
    this.journalBytes += frame.length;
  }

  private snapshotPath(): string {
    return join(this.dir, `${this.name}.db.enc`);
  }

  private journalPath(gen: number): string {
    return join(this.dir, `${this.name}.${gen}.journal`);
  }

  // Binding the name and position into the AAD stops files or frames being swapped around.
  private snapshotAad(gen: number): Buffer {
    return Buffer.from(`snapshot|${this.name}|${gen}`);
  }

  private frameAad(index: number): Buffer {
    return Buffer.from(`journal|${this.name}|${this.gen}|${index}`);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`${this.name} is closed`);
  }

  /** For tests and diagnostics. */
  get journalSize(): number {
    const p = this.journalPath(this.gen);
    return existsSync(p) ? statSync(p).size : 0;
  }
}

function assertParam(p: unknown): void {
  if (p === null || typeof p === 'string' || (typeof p === 'number' && Number.isFinite(p))) return;
  throw new TypeError(`unsupported SQL parameter: ${typeof p}`);
}
