// The hidden page that hosts the translation engine. It only relays messages
// between the main process (through its preload) and the engine worker.

interface EngineBridge {
  onInit(cb: (files: EngineFiles) => void): void;
  onRequest(cb: (id: number, texts: string[]) => void): void;
  ready(ok: boolean, error?: string): void;
  reply(id: number, ok: boolean, value: string[] | string): void;
}

interface EngineFiles {
  wasm: Uint8Array;
  model: Record<'model' | 'lex' | 'srcvocab' | 'trgvocab', Uint8Array>;
}

declare global {
  interface Window {
    engine: EngineBridge;
  }
}

const bridge = window.engine;
const worker = new Worker('worker.js');

worker.onmessage = (e: MessageEvent) => {
  const m = e.data as { type: 'ready'; ok: boolean; error?: string } | { type: 'result'; id: number; ok: boolean; value: string[] | string };
  if (m.type === 'ready') bridge.ready(m.ok, m.error);
  else bridge.reply(m.id, m.ok, m.value);
};
worker.onerror = (e) => bridge.ready(false, e.message || 'translation engine crashed');

bridge.onInit((files) => {
  const buffers = [files.wasm, ...Object.values(files.model)].map((b) => b.buffer as ArrayBuffer);
  worker.postMessage({ type: 'init', files }, buffers);
});
bridge.onRequest((id, texts) => worker.postMessage({ type: 'translate', id, texts }));

export {};
