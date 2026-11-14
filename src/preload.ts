import { contextBridge, ipcRenderer } from 'electron';
import type { View } from './runtime';
import type { UpdateView } from './updates';
async function invoke(channel:string,...args:unknown[]){
  const reply=await ipcRenderer.invoke(channel,...args);
  if(!reply||typeof reply!=='object'||!(Object.keys(reply).length===2||!reply.ok&&Object.keys(reply).length===3&&reply.severity==='info')||typeof reply.ok!=='boolean'||(reply.ok?!Object.hasOwn(reply,'value'):typeof reply.error!=='string'))throw new Error('The launcher returned an invalid reply. Please report this problem.');
  if(!reply.ok){
    // contextBridge strips custom Error names, so expected notices cross as plain data.
    if(reply.severity==='info')throw Object.freeze({name:'Notice',message:reply.error});
    throw new Error(reply.error);
  }
  return reply.value;
}
contextBridge.exposeInMainWorld('launcher', Object.freeze({
  copyLogs:(text:string)=>invoke('logs:copy',text),
  minimize: () => invoke('window:minimize'),
  maximize: () => invoke('window:maximize'),
  close: () => invoke('window:close'),
  status: () => invoke('runtime:status'),
  start: () => invoke('runtime:start'),
  startInstalled: () => invoke('runtime:start-installed'),
  launcherUpdates: () => invoke('launcher:status'),
  checkLauncher: () => invoke('launcher:check'),
  installLauncher: () => invoke('launcher:install'),
  recoverLauncher: () => invoke('launcher:recover'),
  launcherHealthy: () => invoke('launcher:healthy'),
  launcherChanged: (callback:(view:import('./launcher-updates').LauncherUpdateView)=>void) => { ipcRenderer.on('launcher:changed',(_event,view)=>callback(view)); },
  updates: () => invoke('update:status'),
  checkUpdates: () => invoke('update:check'),
  retryUpdate: () => invoke('update:retry'),
  recoverRuntime: () => invoke('update:recover'),
  releases: () => invoke('update:releases'),
  stop: () => invoke('runtime:stop'),
  client: () => invoke('runtime:client'),
  help: () => invoke('runtime:help'),
  listAccounts:()=>invoke('account:list'),
  editAccount:(account:number,expected:string,username:string,password:string)=>invoke('account:edit',account,expected,username,password),
  importPlayer: () => invoke('save:import'),
  confirmImport: (expected: string, password: string, confirmation: string, replace: boolean) => invoke('save:confirm-import', expected, password, confirmation, replace),
  cancelImport: () => invoke('save:cancel-import'),
  makeBackup: () => invoke('save:backup'),
  openBackupFolder: () => invoke('save:folder'),
  listBackups: () => invoke('save:list'),
  saveLocation: () => invoke('save:location'),
  openSaveFolder: () => invoke('save:open-location'),
  restoreBackup: (name?: string) => name === undefined ? invoke('save:restore') : invoke('save:restore', name),
  updatesChanged: (callback:(view:UpdateView)=>void) => {
    ipcRenderer.on('update:changed',(_event,view:UpdateView)=>callback(view));
  },
  changed: (callback: (view: View) => void) => {
    ipcRenderer.on('runtime:changed', (_event, view: View) => callback(view));
  },
}));
