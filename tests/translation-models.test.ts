import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { BUNDLED, loadBundled, sha256, verifiedDecompress } from '../src/main/translation-models';

const VENDOR = join(__dirname, '..', 'vendor', 'bergamot', 'models');

describe('checking translation files', () => {
  it('decompresses a file whose hashes match', () => {
    const raw = Buffer.from('hello');
    const z = zstdCompressSync(raw);
    expect(verifiedDecompress(z, { hash: sha256(z), decompressedHash: sha256(raw) }).toString()).toBe('hello');
  });

  it('rejects a changed file or wrong content', () => {
    const raw = Buffer.from('hello');
    const z = zstdCompressSync(raw);
    const tampered = Buffer.from(z);
    tampered[tampered.length - 1] ^= 1;
    expect(() => verifiedDecompress(tampered, { hash: sha256(z), decompressedHash: sha256(raw) })).toThrow(/校验失败/);
    expect(() => verifiedDecompress(z, { hash: sha256(z), decompressedHash: sha256(Buffer.from('other')) })).toThrow(/解压后/);
  });
});

describe('bundled engine and model', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('ship with MinBrowser and match the hashes Mozilla publishes', () => {
    for (const f of Object.values(BUNDLED)) expect(sha256(readFileSync(join(VENDOR, f.file)))).toBe(f.hash);
    const loaded = loadBundled(VENDOR);
    expect(loaded.wasm.subarray(0, 4).toString('latin1')).toBe('\0asm'); // a WebAssembly module
    expect(Object.keys(loaded.model).sort()).toEqual(['lex', 'model', 'srcvocab', 'trgvocab']);
  });

  it('are refused when a file was replaced', () => {
    dir = mkdtempSync(join(tmpdir(), 'mb-tr-'));
    cpSync(VENDOR, dir, { recursive: true });
    writeFileSync(join(dir, BUNDLED.lex.file), zstdCompressSync(Buffer.from('not the model')));
    expect(() => loadBundled(dir)).toThrow(/校验失败/);
  });
});
