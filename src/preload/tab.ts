import { contextBridge, ipcRenderer } from 'electron';
import { Ipc } from '../shared/ipc';
import { startPageTranslator } from './page-translator';
import { startPasswordAgent } from './password-agent';

// Runs in every tab, in an isolated world the page's own scripts can't reach.
if (location.protocol === 'min:') {
  // Internal pages get a narrow API; the main process checks which page is calling.
  contextBridge.exposeInMainWorld('min', {
    call: (method: string, ...args: unknown[]) => ipcRenderer.invoke(Ipc.Internal, method, args),
  });
} else if ((location.protocol === 'https:' || location.protocol === 'http:') && window.top === window) {
  startPasswordAgent();
  startPageTranslator();
}
