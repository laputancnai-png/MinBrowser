import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { pickEngine, pickModel, RemoteRecord, sha256, TranslationFiles, verifiedDecompress } from '../src/main/translation-models';

const file = (content: string) => {
  const raw = Buffer.from(content);
  const z = zstdCompressSync(raw);
  return { raw, z, hash: sha256(z), decompressedHash: sha256(raw) };
};

const modelRecord = (fileType: string, version: string, extra: Partial<RemoteRecord> = {}): RemoteRecord => {
  const f = file(`${fileType}-${version}`);
  return {
    name: `${fileType}.enzh`,
    version,
    fileType,
    sourceLanguage: 'en',
    targetLanguage: 'zh-Hans',
    architecture: 'base-memory',
    filter_expression: '',
    decompressedHash: f.decompressedHash,
    attachment: { hash: f.hash, size: f.z.length, location: `models/${fileType}-${version}.zst` },
    ...extra,
  };
};
const fullSet = (version: string, extra: Partial<RemoteRecord> = {}) =>
  ['model', 'lex', 'srcvocab', 'trgvocab'].map((t) => modelRecord(t, version, extra));

describe('picking translation files', () => {
  it('accepts only the pinned engine build', () => {
    const pinned = { name: 'bergamot-translator', version: '4.0', attachment: { hash: '327fcfc7b7e9d95f6fa0844ebf899cfc05469872ef02d3aef5783182839a6255', size: 1, location: 'x' } };
    const other = { name: 'bergamot-translator', version: '4.1', attachment: { hash: 'ab'.repeat(32), size: 1, location: 'y' } };
    expect(pickEngine([other, pinned])).toBe(pinned);
    expect(pickEngine([other])).toBeNull();
  });

  it('takes the newest released, complete, unfiltered en → zh-Hans model', () => {
    const records = [
      ...fullSet('3.0'),
      ...fullSet('3.1'),
      ...fullSet('3.2a1'), // pre-release
      ...fullSet('4.0'), // needs a newer engine
      ...fullSet('3.3', { filter_expression: "env.channel == 'nightly'" }),
      ...fullSet('3.4', { targetLanguage: 'zh-Hant' }),
      ...fullSet('3.5').slice(0, 3), // incomplete
    ];
    const picked = pickModel(records);
    expect(picked?.version).toBe('3.1');
    expect(Object.keys(picked!.files).sort()).toEqual(['lex', 'model', 'srcvocab', 'trgvocab']);
  });

  it('finds nothing when no model fits', () => {
    expect(pickModel(fullSet('2.2'))).toBeNull();
  });
});

describe('checking downloaded files', () => {
  it('decompresses a file whose hashes match', () => {
    const f = file('hello');
    expect(verifiedDecompress(f.z, f).toString()).toBe('hello');
  });

  it('rejects a changed download or wrong content', () => {
    const f = file('hello');
    const tampered = Buffer.from(f.z);
    tampered[tampered.length - 1] ^= 1;
    expect(() => verifiedDecompress(tampered, f)).toThrow(/校验失败/);
    expect(() => verifiedDecompress(f.z, { ...f, decompressedHash: sha256(Buffer.from('other')) })).toThrow(/解压后/);
  });
});

describe('TranslationFiles', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function server(engineContent = 'wasm-binary') {
    const engine = file(engineContent);
    const models = fullSet('3.0');
    const blobs = new Map<string, Buffer>();
    blobs.set('engine.zst', engine.z);
    for (const r of models) blobs.set(r.attachment.location, zstdCompressSync(Buffer.from(`${r.fileType}-3.0`)));
    const wasmRecord = { name: 'bergamot-translator', version: '4.0', attachment: { hash: engine.hash, size: engine.z.length, location: 'engine.zst' } };
    const requests: string[] = [];
    const fetcher = async (url: string) => {
      requests.push(url);
      if (url.includes('translations-wasm-v2')) return Response.json({ changes: [wasmRecord] });
      if (url.includes('translations-models-v2')) return Response.json({ changes: models });
      const blob = blobs.get(url.replace('https://cdn/', ''));
      return blob ? new Response(new Uint8Array(blob)) : new Response('missing', { status: 404 });
    };
    return { engine, fetcher, requests };
  }

  it('downloads, verifies, stores privately and loads the files', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mb-tr-'));
    const { engine, fetcher } = server();
    const files = new TranslationFiles(join(dir, 'translations'), fetcher, { settings: 'https://rs', attachments: 'https://cdn/' });
    // Test engine has its own hash; pin it for this test.
    const mod = await import('../src/main/translation-models');
    Object.assign(mod.PINNED_ENGINE, { hash: engine.hash, decompressedHash: engine.decompressedHash });
    expect(files.installed).toBe(false);
    const seen: number[] = [];
    await files.download((p) => seen.push(p));
    expect(files.installed).toBe(true);
    expect(seen[seen.length - 1]).toBe(1);
    const loaded = files.load();
    expect(loaded.wasm.toString()).toBe('wasm-binary');
    expect(loaded.model.trgvocab.toString()).toBe('trgvocab-3.0');

    // A file changed on disk afterwards is refused.
    const p = join(dir, 'translations', 'model.enzh.zst');
    writeFileSync(p, zstdCompressSync(Buffer.from('evil')));
    expect(() => files.load()).toThrow(/校验失败/);
    expect(readFileSync(join(dir, 'translations', 'manifest.json'), 'utf8')).toContain('"version": "3.0"');
  });

  it('keeps nothing from a download that fails its check', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mb-tr-'));
    const { fetcher } = server();
    const mod = await import('../src/main/translation-models');
    Object.assign(mod.PINNED_ENGINE, { hash: 'ff'.repeat(32) });
    const files = new TranslationFiles(join(dir, 'translations'), fetcher, { settings: 'https://rs', attachments: 'https://cdn/' });
    await expect(files.download(() => {})).rejects.toThrow(/不再提供/);
    expect(files.installed).toBe(false);
  });
});
