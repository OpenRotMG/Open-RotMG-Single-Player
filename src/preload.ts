import { contextBridge, ipcRenderer } from 'electron';
import type { View } from './runtime';
import type { UpdateView } from './updates';
contextBridge.exposeInMainWorld('launcher', Object.freeze({
  status: () => ipcRenderer.invoke('runtime:status'),
  start: () => ipcRenderer.invoke('runtime:start'),
  startInstalled: () => ipcRenderer.invoke('runtime:start-installed'),
  launcherUpdates: () => ipcRenderer.invoke('launcher:status'),
  checkLauncher: () => ipcRenderer.invoke('launcher:check'),
  downloadLauncher: () => ipcRenderer.invoke('launcher:download'),
  updates: () => ipcRenderer.invoke('update:status'),
  checkUpdates: () => ipcRenderer.invoke('update:check'),
  retryUpdate: () => ipcRenderer.invoke('update:retry'),
  recoverRuntime: () => ipcRenderer.invoke('update:recover'),
  releases: () => ipcRenderer.invoke('update:releases'),
  stop: () => ipcRenderer.invoke('runtime:stop'),
  client: () => ipcRenderer.invoke('runtime:client'),
  help: () => ipcRenderer.invoke('runtime:help'),
  importPlayer: () => ipcRenderer.invoke('save:import'),
  confirmImport: (expected: string, password: string, confirmation: string, replace: boolean) => ipcRenderer.invoke('save:confirm-import', expected, password, confirmation, replace),
  cancelImport: () => ipcRenderer.invoke('save:cancel-import'),
  makeBackup: () => ipcRenderer.invoke('save:backup'),
  openBackupFolder: () => ipcRenderer.invoke('save:folder'),
  restoreBackup: () => ipcRenderer.invoke('save:restore'),
  updatesChanged: (callback:(view:UpdateView)=>void) => {
    ipcRenderer.on('update:changed',(_event,view:UpdateView)=>callback(view));
  },
  changed: (callback: (view: View) => void) => {
    ipcRenderer.on('runtime:changed', (_event, view: View) => callback(view));
  },
}));
