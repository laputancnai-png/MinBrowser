import { contextBridge, ipcRenderer } from 'electron';
import { Ipc, MinBrowserApi, TabsState } from '../shared/ipc';

const api: MinBrowserApi = {
  platform: process.platform,
  newTab: () => ipcRenderer.send(Ipc.NewTab),
  closeTab: (id) => ipcRenderer.send(Ipc.CloseTab, id),
  activateTab: (id) => ipcRenderer.send(Ipc.ActivateTab, id),
  navigate: (input) => ipcRenderer.send(Ipc.Navigate, input),
  back: () => ipcRenderer.send(Ipc.Back),
  forward: () => ipcRenderer.send(Ipc.Forward),
  reload: () => ipcRenderer.send(Ipc.Reload),
  stop: () => ipcRenderer.send(Ipc.Stop),
  onState: (cb) => ipcRenderer.on(Ipc.State, (_e, state: TabsState) => cb(state)),
  onFocusAddress: (cb) => ipcRenderer.on(Ipc.FocusAddress, () => cb()),
};

contextBridge.exposeInMainWorld('minbrowser', api);
