import { app, BrowserWindow, ipcMain, shell, dialog, clipboard } from 'electron';
import { join } from 'node:path';
import {execFileSync} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {realpath} from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Runtime } from './runtime';
import { SaveControls, isBackupName } from './saves';
import { RuntimeUpdates } from './updates';
import { createUpdatePolicy,createLauncherPolicy } from './update-policy';
import { LauncherUpdates,requireLauncherSaveState } from './launcher-updates';
import {LauncherStore} from './launcher-store';
import { RELEASES_PAGE,targetName } from './update-format';
import { gameSite } from './game-site';
import {UserMessage,UserNotice} from './user-message';
import {desktopName,installDesktopIcon} from './desktop-icon';

app.setName('Open RotMG Single Player');
if(process.platform==='linux'){app.setDesktopName(desktopName);app.commandLine.appendSwitch('class',desktopName.slice(0,-8));}
const playerData=app.getPath('userData');
if(app.isPackaged&&app.commandLine.hasSwitch('portable-root')){
 try{
  const root=realpathSync(app.commandLine.getSwitchValue('portable-root'));
  if(realpathSync(playerData)!==realpathSync(join(root,'player data')))throw Error('Portable save path does not match ownership');
  const native=join(root,process.platform==='win32'?'OpenRotMG Singleplayer.exe':'OpenRotMG Singleplayer');
  const profile=JSON.parse(execFileSync(native,['--launcher-storage',root],{encoding:'utf8',windowsHide:true,timeout:30000})).profile;
  if(profile!==join(root,'server data','profile'))throw Error('Invalid launcher storage acknowledgement');
  app.setPath('userData',profile);app.setPath('sessionData',profile);
  app.commandLine.removeSwitch('user-data-dir');app.commandLine.appendSwitch('user-data-dir',profile);
 }catch(error){dialog.showErrorBox('Could not prepare launcher storage',String(error));app.exit(1);throw error;}
}
// The portable launcher names the save folder; starting this file directly would silently use an unrelated OS profile.
if (app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) {
  dialog.showErrorBox('Open the OpenRotMG Singleplayer program', 'Start the game with "OpenRotMG Singleplayer", next to the "player data" and "server data" folders.');
  app.exit(1);
}
// Chromium's singleton lock is tied to this persistent userData directory, not the install path.
else if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window: BrowserWindow | undefined;
  let runtime: Runtime;
  let saves: SaveControls;
  let updates: RuntimeUpdates;
  let launcherUpdates: LauncherUpdates;
  let site: Awaited<ReturnType<typeof gameSite>>;
  let consoleLog:string|undefined;
  const view = () => ({...runtime.view(),consoleLog,clientURL:runtime.view().status==='ready'?site.url():undefined});
  let quitting = false, closing = false;
  const index = pathToFileURL(join(__dirname, 'index.html')).href;
  app.whenReady().then(async () => {
    const policy = createUpdatePolicy(process.resourcesPath, app.getVersion());
    const userData=app.isPackaged?await realpath(playerData):playerData;
    runtime = new Runtime(policy.baseline.root, userData,app.isPackaged?await realpath(app.getPath('userData')):app.getPath('userData'));
    await runtime.loadSettings();
    site = await gameSite(runtime);
    const portableRoot=app.commandLine.getSwitchValue('portable-root'),generation=app.commandLine.getSwitchValue('launcher-generation');
    if(app.isPackaged&&(!portableRoot||!generation))throw Error('Open the top-level portable launcher; portable ownership is missing');
    const root=portableRoot?await realpath(portableRoot):undefined;
    if(root&&userData!==await realpath(join(root,'player data')))throw Error('Launcher update ownership does not match player data');
    if(root){const operation=app.commandLine.getSwitchValue('launcher-update-health');consoleLog=operation?join(root,'server data/handoff',operation,'console.log'):join(root,'server data/launcher-console.log');}
    const appPolicy=createLauncherPolicy(process.resourcesPath,app.getVersion());
    const store=root?new LauncherStore({root,generation,installed:app.getVersion(),resources:process.resourcesPath,policy:appPolicy,native:join(root,process.platform==='win32'?'OpenRotMG Singleplayer.exe':'OpenRotMG Singleplayer')}):undefined;
    launcherUpdates = new LauncherUpdates(app.getVersion(),targetName(),appPolicy.request,store);
    launcherUpdates.on('log',message=>runtime.reportUpdate('Launcher: '+message));
    await launcherUpdates.startup();
    if(root&&process.platform==='linux')await installDesktopIcon(process.env.XDG_DATA_HOME??join(app.getPath('home'),'.local/share'),join(root,'OpenRotMG Singleplayer'),join(__dirname,'assets/app-icon.png'));
    window = new BrowserWindow({ icon:join(__dirname,'assets/app-icon.png'), width: 900, height: 700, minWidth: 360, minHeight: 480, frame: false, title: 'Open RotMG Single Player',
      webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== index && !details.url.startsWith(pathToFileURL(__dirname + '/').href) }));
    saves = new SaveControls(runtime, {
      choose: async (kind, directory) => {
        const result = await dialog.showOpenDialog(window!, { title: kind === 'account' ? 'Import player: choose your exported account file' : 'Restore full local backup', defaultPath: kind === 'snapshot' ? directory : undefined, properties: ['openFile'], filters: kind === 'account' ? [{name: 'Portable account', extensions: ['json']}] : [{name: 'Full local backup', extensions: ['sqlite', 'db']}] });
        if (result.canceled) return undefined;
        if (result.filePaths.length !== 1) throw new Error('Native save chooser did not return exactly one file');
        return result.filePaths[0];
      },
      confirmRestore: async (preview, path, modified) => (await dialog.showMessageBox(window!, {
        type: 'warning', title: 'Replace the full local save?', message: 'Restore all local accounts and original passwords?',
        detail: `${path}\nFile modified: ${modified}\n${preview.account_count} accounts · ${preview.character_count} characters\nAll current local progress and passwords will be replaced. A backup of your current save must be made and checked first.`,
        buttons: ['Cancel', 'Restore full local save'], defaultId: 0, cancelId: 0, noLink: true,
      })).response === 1,
      openFolder: path => shell.openPath(path),
    });
    updates = new RuntimeUpdates(runtime, policy, async prompt => (await dialog.showMessageBox(window!, {
      type:'warning',title:'Game update or save recovery',message:prompt.message,detail:prompt.detail,
      buttons:['Cancel',prompt.kind==='restore-update'?'Back up current save and restore':prompt.kind==='retry-update'?'Retry update':'Verify and continue'],defaultId:0,cancelId:0,noLink:true,
    })).response===1);
    const checked = (channel: string, action: (...args: unknown[]) => unknown, valid: (args: unknown[]) => boolean = args => args.length === 0) => ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== index || !valid(args)) throw new Error('Rejected untrusted IPC sender or arguments');
      return (async()=>{
        try{
          if(closing&&!['launcher:status','runtime:status','update:status','logs:copy','window:minimize','window:maximize'].includes(channel))throw new UserNotice('The launcher is closing. Please wait.');
          if(launcherUpdates.busy&&!['launcher:status','runtime:status','update:status','window:minimize','window:maximize','logs:copy','save:location',...(launcherUpdates.view().phase==='downloading'?['window:close']:[])].includes(channel))throw new UserNotice('The launcher is updating. Please wait.');
          if(launcherUpdates.view().blocked&&['runtime:start','runtime:start-installed','runtime:client','runtime:bots','save:import','save:confirm-import','save:backup','save:restore','account:list','account:edit'].includes(channel))throw new UserMessage('Check launcher files in Settings → Updates before playing.');
          return{ok:true,value:await action(...args)};
        }
        catch(error){if(error instanceof UserNotice)return{ok:false,error:error.message,severity:'info'};runtime.reportProblem(error);return{ok:false,error:error instanceof UserMessage?error.message:'This action did not finish. See Advanced → Logs for details.'};}
      })();
    });
    checked('logs:copy',text=>clipboard.writeText(text as string),args=>args.length===1&&typeof args[0]==='string'&&Buffer.byteLength(args[0])<=1024*1024);
    checked('window:minimize', () => window!.minimize());
    checked('window:maximize', () => { if(window!.isMaximized())window!.unmaximize();else window!.maximize(); });
    checked('window:close', () => window!.close());
    checked('runtime:status', view);
    checked('runtime:bots',enabled=>runtime.setBots(enabled as boolean),args=>args.length===1&&typeof args[0]==='boolean');
    checked('runtime:start', () => runtime.start());
    checked('runtime:start-installed', () => {
      if(!updates.view().canPlayInstalled)throw new Error('Explicit installed-version play requires a rejected/unavailable check, verified stopped selection and no pending ambiguity');
      return runtime.start(true);
    });
    checked('launcher:status', () => launcherUpdates.view());
    checked('launcher:check', () => launcherUpdates.check());
    checked('launcher:download', () => shell.openExternal(launcherUpdates.download()));
    checked('launcher:install', async () => {
      try{
        requireLauncherSaveState(runtime.view(),updates.view());const prepared=await launcherUpdates.prepare();if(closing)throw new UserMessage('Launcher update canceled while closing.');closing=true;
        await Promise.all([saves.cancelImport(),runtime.close()]);requireLauncherSaveState(runtime.view(),updates.view(),true);await site.close();
        launcherUpdates.step('Starting authenticated update helper');await launcherUpdates.arm(prepared);quitting=true;app.exit(73);
      }catch(error){launcherUpdates.failed(error);runtime.reportProblem(error);throw error instanceof UserMessage?error:new UserMessage('The launcher update did not finish. Keep player data. See Advanced → Logs.');}
      finally{closing=false;}
    });
    checked('launcher:recover', () => launcherUpdates.recover());
    checked('launcher:healthy', async () => {const operation=app.commandLine.getSwitchValue('launcher-update-health');if(operation&&launcherUpdates.view().blocked){await launcherUpdates.healthy(operation);try{await launcherUpdates.prune();}catch(error){runtime.reportProblem(new Error('Launcher update completed, but old code cleanup failed: '+String(error)));}}});
    checked('update:status', () => updates.view());
    checked('update:check', () => updates.check());
    checked('update:retry', () => updates.retry());
    checked('update:recover', () => updates.recover());
    checked('update:releases', () => shell.openExternal(RELEASES_PAGE));
    checked('runtime:stop', () => runtime.stop());
    checked('runtime:client', async () => {
      if (runtime.view().status !== 'ready' || runtime.view().operation || runtime.view().closing) throw new Error('Server is not ready');
      await shell.openExternal(site.url());
    });
    checked('runtime:help', () => shell.openExternal('https://openrotmg.org/export/'));
    checked('account:list',()=>saves.listAccounts());
    checked('account:edit',(account,expected,username,password)=>saves.editAccount(account,expected,username,password),args=>args.length===4&&Number.isSafeInteger(args[0])&&Number(args[0])>0&&typeof args[1]==='string'&&/^[a-f0-9]{64}$/.test(args[1])&&typeof args[2]==='string'&&args[2].length<=245&&typeof args[3]==='string'&&Buffer.byteLength(args[3])<=128);
    checked('save:import', () => saves.beginImport());
    checked('save:confirm-import', (expected, password, confirmation, replace) => saves.finishImport(expected, password, confirmation, replace), args => args.length === 4 && typeof args[0] === 'string' && /^[a-f0-9]{64}$/.test(args[0]) && typeof args[1] === 'string' && typeof args[2] === 'string' && Buffer.byteLength(args[1]) <= 128 && Buffer.byteLength(args[2]) <= 128 && typeof args[3] === 'boolean');
    checked('save:cancel-import', () => saves.cancelImport());
    checked('save:backup', () => saves.makeBackup());
    checked('save:folder', () => saves.openBackupFolder());
    checked('save:list', () => saves.listBackups());
    checked('save:location', () => runtime.userData);
    checked('save:open-location', () => saves.openSaveFolder());
    checked('save:restore', name => saves.restoreBackup(name as string | undefined), args => args.length === 0 || args.length === 1 && isBackupName(args[0]));
    runtime.on('change', () => { if (window && !window.isDestroyed()) window.webContents.send('runtime:changed', view()); });
    updates.on('change', view => { if (window && !window.isDestroyed()) window.webContents.send('update:changed', view); });
    launcherUpdates.on('change', view => { if (window && !window.isDestroyed()) window.webContents.send('launcher:changed',view); });
    void updates.startup();
    window.on('close', event => { if (!quitting) { event.preventDefault(); void close(); } });
    void window.loadURL(index);
  }).catch(error => { console.error(error);dialog.showErrorBox('The game could not open', 'Keep your player data folder. Please report this problem with server data/launcher-console.log.\n'+String(error)); app.exit(1); });
  async function close() {
    if (closing) return;
    closing = true;
    launcherUpdates.abort();
    try { const stopped = runtime.close(); await Promise.all([saves.cancelImport(), stopped]); await site.close(); quitting = true; app.quit(); }
    catch (error) {
      if (runtime.view().status !== 'failed') {
        runtime.reportProblem(error);dialog.showErrorBox('The game could not close normally', 'The launcher will stay open. Check Advanced → Logs before trying again. Your save has not been confirmed.');
        return;
      }
      try { await runtime.verifyFailureGate(); }
      catch (persistenceError) {
        runtime.reportProblem(persistenceError);dialog.showErrorBox('Please keep the launcher open', 'We could not record the save problem safely. Keep your player data folder and report the details in Advanced → Logs.');
        return;
      }
      // Keep the app and ownership alive while an unverified child may still be draining.
      runtime.reportProblem(error);dialog.showErrorBox('Your save needs to be checked', 'We could not confirm the last save. Keep your player data folder. Use Check save before playing again. Details are in Advanced → Logs.');
      if (!runtime.view().pid) { quitting = true; app.exit(1); }
    } finally { closing = false; }
  }
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void close(); } });
  app.on('window-all-closed', () => { if (quitting) app.quit(); });
}
