// The translation engine: Mozilla's Bergamot (vendor/bergamot), set up the way
// Firefox sets it up (toolkit/components/translations/content/translations-engine.worker.js).
// Runs in a worker of a sandboxed page whose session blocks all network access.

/* eslint-disable @typescript-eslint/no-explicit-any */
declare function importScripts(...urls: string[]): void;
declare function loadBergamot(module: Record<string, unknown>): any;

importScripts('bergamot-translator.js');

type FileType = 'model' | 'lex' | 'srcvocab' | 'trgvocab';
const ALIGNMENT: Record<FileType, number> = { model: 256, lex: 64, srcvocab: 64, trgvocab: 64 };

let bergamot: any = null;
let model: any = null;
let service: any = null;

const post = (message: unknown) => (self as unknown as Worker).postMessage(message);

function initEngine(wasm: Uint8Array): Promise<any> {
  return new Promise((resolve, reject) => {
    const instance = loadBergamot({
      INITIAL_MEMORY: 41_943_040,
      print: () => {},
      printErr: () => {},
      wasmBinary: wasm,
      onAbort: () => reject(new Error('translation engine failed to start')),
      onRuntimeInitialized: () => setTimeout(() => resolve(instance)),
    });
  });
}

function aligned(buffer: Uint8Array, alignment: number): any {
  const memory = new bergamot.AlignedMemory(buffer.byteLength, alignment);
  memory.getByteArrayView().set(buffer);
  return memory;
}

// Marian wants this exact indentation.
function config(values: Record<string, string>): string {
  const indent = '            ';
  return `\n${Object.entries(values).map(([k, v]) => `${indent}${k}: ${v}\n`).join('')}${indent}`;
}

async function init(files: { wasm: Uint8Array; model: Record<FileType, Uint8Array> }): Promise<void> {
  bergamot = await initEngine(files.wasm);
  const vocabs = new bergamot.AlignedMemoryList();
  vocabs.push_back(aligned(files.model.srcvocab, ALIGNMENT.srcvocab));
  vocabs.push_back(aligned(files.model.trgvocab, ALIGNMENT.trgvocab));
  model = new bergamot.TranslationModel(
    'en',
    'zh',
    config({
      'beam-size': '1',
      normalize: '1.0',
      'word-penalty': '0',
      'max-length-break': '128',
      'mini-batch-words': '1024',
      workspace: '128',
      'max-length-factor': '2.0',
      'skip-cost': 'true',
      'cpu-threads': '0',
      quiet: 'true',
      'quiet-translation': 'true',
      'gemm-precision': 'int8shiftAlphaAll',
      alignment: 'soft',
    }),
    aligned(files.model.model, ALIGNMENT.model),
    aligned(files.model.lex, ALIGNMENT.lex),
    vocabs,
    null,
  );
  service = new bergamot.BlockingService({ cacheSize: 0 });
}

/** Plain text only: this model can't place HTML tags, so pages are translated text by text. */
function translate(texts: string[]): string[] {
  const messages = new bergamot.VectorString();
  const options = new bergamot.VectorResponseOptions();
  try {
    for (const text of texts) {
      messages.push_back(text);
      options.push_back({ qualityScores: false, alignment: false, html: false });
    }
    const responses = service.translate(model, messages, options);
    const out: string[] = [];
    for (let i = 0; i < texts.length; i++) out.push(responses.get(i).getTranslatedText());
    responses.delete();
    return out;
  } finally {
    messages.delete();
    options.delete();
  }
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data as { type: 'init'; files: { wasm: Uint8Array; model: Record<FileType, Uint8Array> } } | { type: 'translate'; id: number; texts: string[] };
  if (m.type === 'init') {
    try {
      await init(m.files);
      post({ type: 'ready', ok: true });
    } catch (err) {
      post({ type: 'ready', ok: false, error: String(err instanceof Error ? err.message : err) });
    }
    return;
  }
  try {
    post({ type: 'result', id: m.id, ok: true, value: translate(m.texts) });
  } catch (err) {
    post({ type: 'result', id: m.id, ok: false, value: String(err instanceof Error ? err.message : err) });
  }
};
