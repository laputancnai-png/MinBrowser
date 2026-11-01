import { contextBridge, ipcRenderer } from 'electron';
import { Ipc, Rect } from '../shared/ipc';

// The split-view drag layer: reports the pointer, shows the drop preview.
contextBridge.exposeInMainWorld('shield', {
  send: (kind: 'down' | 'move' | 'up' | 'cancel', x: number, y: number) => ipcRenderer.send(Ipc.ShieldEvent, kind, x, y),
  onMode: (cb: (mode: string, orientation: string) => void) => ipcRenderer.on(Ipc.ShieldMode, (_e, mode, orientation) => cb(mode, orientation)),
  onZone: (cb: (rect: Rect | null) => void) => ipcRenderer.on(Ipc.ShieldZone, (_e, rect) => cb(rect)),
});
