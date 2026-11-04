import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

/**
 * English → Simplified Chinese translation files: Mozilla's Bergamot engine
 * (WebAssembly) and the language model Firefox uses. Downloaded once from
 * Mozilla's Remote Settings, checked against the published SHA-256 hashes
 * (compressed and decompressed), and kept zstd-compressed in the data folder.
 * The files are public; nothing about the user is sent to fetch them.
 */

export const REMOTE_SETTINGS = 'https://firefox.settings.services.mozilla.com/v1/buckets/main/collections';
export const ATTACHMENTS = 'https://firefox-settings-attachments.cdn.mozilla.net/';

/**
 * The engine must match the JavaScript loader bundled in vendor/bergamot, so
 * only this exact build is accepted (record "bergamot-translator" 4.0).
 */
export const PINNED_ENGINE = {
  hash: '327fcfc7b7e9d95f6fa0844ebf899cfc05469872ef02d3aef5783182839a6255',
  decompressedHash: 'f38ef807636a7c994afedaab7ff8ffe0d590d21897f05139f747b80fd7bbe926',
};

/** Model versions this engine can run (Firefox: LANGUAGE_MODEL_MAJOR_VERSION 3). */
const MODEL_MAJOR = 3;
const MODEL_FILE_TYPES = ['model', 'lex', 'srcvocab', 'trgvocab'] as const;
export type ModelFileType = (typeof MODEL_FILE_TYPES)[number];

export interface RemoteRecord {
  name: string;
  version: string;
  fileType?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  architecture?: string;
  filter_expression?: string;
  decompressedHash?: string;
  attachment: { hash: string; size: number; location: string };
}

export interface FileEntry {
  file: string;
  hash: string;
  decompressedHash: string;
  size: number;
  location: string;
}

export interface Manifest {
  engine: FileEntry;
  model: { version: string; files: Record<ModelFileType, FileEntry> };
}

export interface LoadedFiles {
  wasm: Buffer;
  model: Record<ModelFileType, Buffer>;
}

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The pinned engine build, if Mozilla still publishes it. */
export function pickEngine(records: RemoteRecord[]): RemoteRecord | null {
  return records.find((r) => r.name === 'bergamot-translator' && r.attachment?.hash === PINNED_ENGINE.hash) ?? null;
}

const versionParts = (v: string) => v.split('.').map((n) => Number(n));

/**
 * The newest complete English → Simplified Chinese model of a supported
 * version: released versions only ("3.1", not "3.0a1"), no channel filters.
 */
export function pickModel(records: RemoteRecord[]): { version: string; files: Record<ModelFileType, RemoteRecord> } | null {
  const sets = new Map<string, Partial<Record<ModelFileType, RemoteRecord>>>();
  for (const r of records) {
    if (r.sourceLanguage !== 'en' || r.targetLanguage !== 'zh-Hans' || r.filter_expression) continue;
    if (!/^\d+\.\d+$/.test(r.version) || versionParts(r.version)[0] !== MODEL_MAJOR) continue;
    if (!MODEL_FILE_TYPES.includes(r.fileType as ModelFileType) || !r.decompressedHash) continue;
    const key = `${r.version}|${r.architecture ?? ''}`;
    const set = sets.get(key) ?? {};
    set[r.fileType as ModelFileType] = r;
    sets.set(key, set);
  }
  let best: { version: string; files: Record<ModelFileType, RemoteRecord> } | null = null;
  for (const [key, set] of sets) {
    if (!MODEL_FILE_TYPES.every((t) => set[t])) continue;
    const version = key.split('|')[0];
    const [a, b] = versionParts(version);
    if (!best || a > versionParts(best.version)[0] || (a === versionParts(best.version)[0] && b > versionParts(best.version)[1])) {
      best = { version, files: set as Record<ModelFileType, RemoteRecord> };
    }
  }
  return best;
}

/** Check a downloaded (compressed) file and what it decompresses to. */
export function verifiedDecompress(compressed: Uint8Array, entry: Pick<FileEntry, 'hash' | 'decompressedHash'>): Buffer {
  if (sha256(compressed) !== entry.hash) throw new Error('翻译文件校验失败（下载的文件不完整或被修改）');
  const raw = zstdDecompressSync(compressed);
  if (sha256(raw) !== entry.decompressedHash) throw new Error('翻译文件校验失败（解压后内容不符）');
  return raw;
}

export type Fetcher = (url: string) => Promise<Response>;

export class TranslationFiles {
  constructor(
    private readonly dir: string,
    private readonly fetcher: Fetcher,
    private readonly sources = { settings: REMOTE_SETTINGS, attachments: ATTACHMENTS },
  ) {}

  private manifestPath(): string {
    return join(this.dir, 'manifest.json');
  }

  manifest(): Manifest | null {
    try {
      const m = JSON.parse(readFileSync(this.manifestPath(), 'utf8')) as Manifest;
      const all = [m.engine, ...Object.values(m.model.files)];
      return all.every((f) => existsSync(join(this.dir, f.file))) ? m : null;
    } catch {
      return null;
    }
  }

  get installed(): boolean {
    return this.manifest() !== null;
  }

  /** Download everything that's missing. `progress` gets 0..1. */
  async download(progress: (fraction: number) => void): Promise<void> {
    const json = async (collection: string) => {
      const res = await this.fetcher(`${this.sources.settings}/${collection}/changeset?_expected=0`);
      if (!res.ok) throw new Error(`无法获取翻译模型列表（${res.status}）`);
      return ((await res.json()) as { changes: RemoteRecord[] }).changes;
    };
    const engine = pickEngine(await json('translations-wasm-v2'));
    if (!engine) throw new Error('Mozilla 已不再提供这个版本的翻译引擎，请更新 MinBrowser');
    const model = pickModel(await json('translations-models-v2'));
    if (!model) throw new Error('找不到英译中的翻译模型');

    const entry = (r: RemoteRecord, file: string): FileEntry => ({
      file,
      hash: r.attachment.hash,
      decompressedHash: r.decompressedHash ?? '',
      size: r.attachment.size,
      location: r.attachment.location,
    });
    const manifest: Manifest = {
      engine: { ...entry(engine, 'engine.wasm.zst'), decompressedHash: PINNED_ENGINE.decompressedHash },
      model: {
        version: model.version,
        files: Object.fromEntries(MODEL_FILE_TYPES.map((t) => [t, entry(model.files[t], `${t}.enzh.zst`)])) as Record<ModelFileType, FileEntry>,
      },
    };

    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const files = [manifest.engine, ...MODEL_FILE_TYPES.map((t) => manifest.model.files[t])];
    const total = files.reduce((n, f) => n + f.size, 0);
    let done = 0;
    for (const f of files) {
      const res = await this.fetcher(this.sources.attachments + f.location);
      if (!res.ok || !res.body) throw new Error(`下载翻译模型失败（${res.status}）`);
      const chunks: Uint8Array[] = [];
      const reader = res.body.getReader();
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        chunks.push(value);
        done += value.byteLength;
        progress(Math.min(done / total, 1));
      }
      const body = Buffer.concat(chunks);
      verifiedDecompress(body, f); // check now, so a bad download is never kept
      const path = join(this.dir, f.file);
      writeFileSync(`${path}.part`, body, { mode: 0o600 });
      renameSync(`${path}.part`, path);
    }
    // The manifest goes last: files without one are an unfinished download.
    writeFileSync(this.manifestPath(), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    chmodSync(this.dir, 0o700);
  }

  /** Read, decompress and re-check every file. */
  load(): LoadedFiles {
    const m = this.manifest();
    if (!m) throw new Error('翻译模型还没有下载');
    const read = (f: FileEntry) => verifiedDecompress(readFileSync(join(this.dir, f.file)), f);
    return {
      wasm: read(m.engine),
      model: Object.fromEntries(MODEL_FILE_TYPES.map((t) => [t, read(m.model.files[t])])) as Record<ModelFileType, Buffer>,
    };
  }

  remove(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
