import { mkdtempSync, readdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { randomKey } from '../src/main/crypto';
import { EncryptedStore } from '../src/main/store';

const SCHEMA = 'CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)';
let dir: string;
let key: Buffer;
const openStore = (k = key) => EncryptedStore.open(dir, 'test', Buffer.from(k), SCHEMA);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'minb-store-'));
  key = randomKey();
});

describe('EncryptedStore', () => {
  it('persists writes across close and reopen', () => {
    const s = openStore();
    s.run('INSERT INTO t (v) VALUES (?)', 'secret-value-1');
    s.close();
    const s2 = openStore();
    expect(s2.all('SELECT v FROM t')).toEqual([{ v: 'secret-value-1' }]);
    s2.close();
  });

  it('recovers writes from the journal without a clean close (crash)', () => {
    const s = openStore();
    s.run('INSERT INTO t (v) VALUES (?)', 'a');
    s.run('INSERT INTO t (v) VALUES (?)', 'b');
    // no close(): simulate the process dying
    const s2 = openStore();
    expect(s2.all<{ v: string }>('SELECT v FROM t ORDER BY id').map((r) => r.v)).toEqual(['a', 'b']);
    s2.close();
  });

  it('never writes plaintext to disk', () => {
    const s = openStore();
    s.run('INSERT INTO t (v) VALUES (?)', 'https://very-private.example/page');
    for (const f of readdirSync(dir)) {
      expect(readFileSync(join(dir, f)).includes('very-private')).toBe(false);
    }
    s.close();
    for (const f of readdirSync(dir)) {
      expect(readFileSync(join(dir, f)).includes('very-private')).toBe(false);
    }
  });

  it('refuses to open with the wrong key', () => {
    const s = openStore();
    s.run('INSERT INTO t (v) VALUES (?)', 'x');
    s.close();
    expect(() => openStore(randomKey())).toThrow();
  });

  it('ignores a torn final journal frame', () => {
    const s = openStore();
    s.run('INSERT INTO t (v) VALUES (?)', 'kept');
    const journal = readdirSync(dir).find((f) => f.endsWith('.journal'))!;
    appendFileSync(join(dir, journal), Buffer.from([0, 0, 1, 0, 1, 2, 3])); // half-written frame
    const s2 = openStore();
    expect(s2.all('SELECT v FROM t')).toEqual([{ v: 'kept' }]);
    s2.run('INSERT INTO t (v) VALUES (?)', 'after');
    const s3 = openStore();
    expect(s3.all<{ v: string }>('SELECT v FROM t ORDER BY id').map((r) => r.v)).toEqual(['kept', 'after']);
  });

  it('does not replay an old journal after a snapshot (crash between rename and delete)', () => {
    const s = openStore();
    s.run('INSERT INTO t (v) VALUES (?)', 'once');
    const journal = readdirSync(dir).find((f) => f.endsWith('.journal'))!;
    const copy = readFileSync(join(dir, journal));
    s.close(); // snapshot written, journal deleted
    writeFileSync(join(dir, journal), copy); // the stale journal comes back
    const s2 = openStore();
    expect(s2.all('SELECT v FROM t')).toEqual([{ v: 'once' }]);
  });

  it('rolls back a failing batch entirely', () => {
    const s = openStore();
    expect(() =>
      s.batch([
        { sql: 'INSERT INTO t (v) VALUES (?)', params: ['ok'] },
        { sql: 'INSERT INTO nope VALUES (1)' },
      ]),
    ).toThrow();
    expect(s.all('SELECT * FROM t')).toEqual([]);
    const s2 = openStore();
    expect(s2.all('SELECT * FROM t')).toEqual([]);
  });

  it('compacts the journal into a snapshot', () => {
    const s = openStore();
    for (let i = 0; i < 1001; i++) s.run('INSERT INTO t (v) VALUES (?)', `row${i}`);
    expect(s.journalSize).toBeLessThan(1000);
    const s2 = openStore();
    expect(s2.get<{ n: number }>('SELECT count(*) n FROM t')!.n).toBe(1001);
  });
});
