import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

/**
 * English → Simplified Chinese translation files: Mozilla's Bergamot engine
 * (WebAssembly) and the language model Firefox uses, shipped with MinBrowser
 * (vendor/bergamot/models, MPL-2.0, unchanged). Translation never needs the
 * network. Mozilla's file server refuses Chromium-based browsers, so they are
 * not downloaded at run time.
 *
 * Every file is pinned by the SHA-256 Mozilla publishes for it (Remote
 * Settings collections translations-wasm-v2 / translations-models-v2), both
 * compressed and decompressed, and checked each time it is loaded.
 * To update: node scripts/update-translation-model.mjs (see vendor/bergamot/README.md).
 */

export type ModelFileType = 'model' | 'lex' | 'srcvocab' | 'trgvocab';

export interface PinnedFile {
  file: string;
  hash: string;
  decompressedHash: string;
}

export const BUNDLED: Record<'engine' | ModelFileType, PinnedFile> = {
  // translations-wasm-v2: bergamot-translator 4.0 (matches vendor/bergamot/bergamot-translator.js)
  engine: {
    file: 'engine.wasm.zst',
    hash: '327fcfc7b7e9d95f6fa0844ebf899cfc05469872ef02d3aef5783182839a6255',
    decompressedHash: 'f38ef807636a7c994afedaab7ff8ffe0d590d21897f05139f747b80fd7bbe926',
  },
  // translations-models-v2: en → zh-Hans 3.0, base-memory
  model: {
    file: 'model.enzh.zst',
    hash: 'f0c96e546b0af7c1fe84647d450b1eba0b0591c167e1ead135b334e4b54f6e08',
    decompressedHash: '4e5accc141373565ddc8fa1565bceaa8d0c3482a82cab8131c719ebcc6c2157c',
  },
  lex: {
    file: 'lex.enzh.zst',
    hash: 'c7e4b2ee202e6cf526d07f9c5a47b759ba32b0b42a5353d3db4ee1ff3bfb5217',
    decompressedHash: '4a5e5827788060f1d718a8132b69440929387514a045796e9b77f935db68c055',
  },
  srcvocab: {
    file: 'srcvocab.enzh.zst',
    hash: 'ec495ad8f0c80ba4eae5ac3b9a8e2ccb4a3a7becb1992efcfea5f4653ffdece1',
    decompressedHash: 'bd9b65504acc6d9726dd281f7defc2adb7c2c22d0688fe2f84697de25197c8c5',
  },
  trgvocab: {
    file: 'trgvocab.enzh.zst',
    hash: '25c6c984a7556cb6478b9f1748ff68d8fd433c0e7d472bfdbd4d64a2dffa21f1',
    decompressedHash: 'aded6993c36e440284d11cec3f6b8aef9c0e43188a772d80be342a713adf223d',
  },
};

/** Where the build puts the bundled files (dist/translation-models). */
export const BUNDLED_DIR = join(__dirname, '..', 'translation-models');

export interface LoadedFiles {
  wasm: Buffer;
  model: Record<ModelFileType, Buffer>;
}

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Check a compressed file and what it decompresses to against its pinned hashes. */
export function verifiedDecompress(compressed: Uint8Array, pinned: Pick<PinnedFile, 'hash' | 'decompressedHash'>): Buffer {
  if (sha256(compressed) !== pinned.hash) throw new Error('翻译文件校验失败（文件被修改或损坏），请重新安装 MinBrowser');
  const raw = zstdDecompressSync(compressed);
  if (sha256(raw) !== pinned.decompressedHash) throw new Error('翻译文件校验失败（解压后内容不符），请重新安装 MinBrowser');
  return raw;
}

/** Read, decompress and check the bundled engine and model. */
export function loadBundled(dir = BUNDLED_DIR, pinned = BUNDLED): LoadedFiles {
  const read = (f: PinnedFile) => verifiedDecompress(readFileSync(join(dir, f.file)), f);
  return {
    wasm: read(pinned.engine),
    model: { model: read(pinned.model), lex: read(pinned.lex), srcvocab: read(pinned.srcvocab), trgvocab: read(pinned.trgvocab) },
  };
}
