import { contextBridge, ipcRenderer } from 'electron';
import { Ipc } from '../shared/ipc';

// The bookmark bubble: only its own small set of commands.
contextBridge.exposeInMainWorld('popup', {
  call: (name: string, ...args: unknown[]) => ipcRenderer.invoke(Ipc.Popup, name, ...args),
});
