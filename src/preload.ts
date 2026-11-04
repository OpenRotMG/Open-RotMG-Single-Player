import { contextBridge, ipcRenderer } from 'electron';
import type { View } from './runtime';
contextBridge.exposeInMainWorld('launcher', Object.freeze({
  status: () => ipcRenderer.invoke('runtime:status'),
  start: () => ipcRenderer.invoke('runtime:start'),
  stop: () => ipcRenderer.invoke('runtime:stop'),
  client: () => ipcRenderer.invoke('runtime:client'),
  help: () => ipcRenderer.invoke('runtime:help'),
  importPlayer: () => ipcRenderer.invoke('save:import'),
  confirmImport: (expected: string, password: string, confirmation: string, replace: boolean) => ipcRenderer.invoke('save:confirm-import', expected, password, confirmation, replace),
  cancelImport: () => ipcRenderer.invoke('save:cancel-import'),
  makeBackup: () => ipcRenderer.invoke('save:backup'),
  openBackupFolder: () => ipcRenderer.invoke('save:folder'),
  restoreBackup: () => ipcRenderer.invoke('save:restore'),
  changed: (callback: (view: View) => void) => {
    ipcRenderer.on('runtime:changed', (_event, view: View) => callback(view));
  },
}));
