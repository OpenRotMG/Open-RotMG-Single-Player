import { contextBridge, ipcRenderer } from 'electron';
import type { View } from './runtime';
contextBridge.exposeInMainWorld('launcher', Object.freeze({
  status: () => ipcRenderer.invoke('runtime:status'),
  start: () => ipcRenderer.invoke('runtime:start'),
  stop: () => ipcRenderer.invoke('runtime:stop'),
  client: () => ipcRenderer.invoke('runtime:client'),
  help: () => ipcRenderer.invoke('runtime:help'),
  changed: (callback: (view: View) => void) => {
    ipcRenderer.on('runtime:changed', (_event, view: View) => callback(view));
  },
}));
