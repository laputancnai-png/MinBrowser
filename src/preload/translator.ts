import { contextBridge, ipcRenderer } from 'electron';
import { Ipc } from '../shared/ipc';

// The hidden translation engine page: receives the engine files and texts to
// translate from the main process, and sends results back. Nothing else.
contextBridge.exposeInMainWorld('engine', {
  onInit: (cb: (files: unknown) => void) => ipcRenderer.on(Ipc.TranslatorInit, (_e, files) => cb(files)),
  onRequest: (cb: (id: number, texts: string[]) => void) => ipcRenderer.on(Ipc.TranslatorRequest, (_e, id, texts) => cb(id, texts)),
  ready: (ok: boolean, error?: string) => ipcRenderer.send(Ipc.TranslatorReady, ok, error),
  reply: (id: number, ok: boolean, value: unknown) => ipcRenderer.send(Ipc.TranslatorReply, id, ok, value),
});
