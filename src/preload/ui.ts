import { contextBridge, ipcRenderer } from 'electron';
import { Ipc, MinBrowserApi, UiState } from '../shared/ipc';

const api: MinBrowserApi = {
  platform: process.platform,
  command: (name, ...args) => ipcRenderer.invoke(Ipc.Command, name, ...args),
  onState: (cb) => ipcRenderer.on(Ipc.State, (_e, state: UiState) => cb(state)),
  onFocusAddress: (cb) => ipcRenderer.on(Ipc.FocusAddress, () => cb()),
  onStarRequest: (cb) => ipcRenderer.on(Ipc.StarRequest, () => cb()),
  onFind: (cb) => ipcRenderer.on(Ipc.Find, (_e, action) => cb(action)),
  onFindResult: (cb) => ipcRenderer.on(Ipc.FindResult, (_e, result) => cb(result)),
};

contextBridge.exposeInMainWorld('minbrowser', api);
