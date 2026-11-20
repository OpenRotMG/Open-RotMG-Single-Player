import { app, BrowserWindow, ipcMain, shell, dialog, clipboard } from 'electron';
import { join } from 'node:path';
import {execFileSync} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {realpath} from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Runtime } from './runtime';
import { SaveControls, isBackupName } from './saves';
import { createLauncherPolicy } from './update-policy';
import { LauncherUpdates,requireLauncherSaveState } from './launcher-updates';
import {LauncherStore} from './launcher-store';
import {ServerUpdates,newestServer} from './server-updates';
import { targetName } from './update-format';
import { gameSite } from './game-site';
import {Multiplayer,joinURL} from './multiplayer';
import {UserMessage,UserNotice} from './user-message';
import {Journal,Problem,explain,identity,report} from './diagnostics';
import {dirname} from 'node:path';
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
  let launcherUpdates: LauncherUpdates;
  let serverUpdates: ServerUpdates;
  let site: Awaited<ReturnType<typeof gameSite>>;
  let multiplayer: Multiplayer;
  let journal: Journal, about: Record<string, unknown>, lastProblem: Problem|undefined;
  const problem=(error:unknown,step:string)=>{lastProblem=explain(error,step);journal.write('problem',{...lastProblem,error:String(error)});return lastProblem;};
  let shownFailure:Error|undefined,failureProblem:Problem|undefined;
  const view = () => {
    const current=runtime.view();
    if(current.status==='failed'&&runtime.failure&&runtime.failure!==shownFailure){shownFailure=runtime.failure;failureProblem=problem(runtime.failure,'playing');}
    return {...current,problem:current.status==='failed'?failureProblem:undefined,clientURL:current.status==='ready'?site.url():undefined};
  };
  let quitting = false, closing = false;
  const index = pathToFileURL(join(__dirname, 'index.html')).href;
  // Status polling and window chrome would drown the journal's record of what the player did.
  const journaled=(channel:string)=>!/:status$|^window:|^report:|^save:(list|location)$/.test(channel);
  app.whenReady().then(async () => {
    const userData=app.isPackaged?await realpath(playerData):playerData,storage=app.isPackaged?await realpath(app.getPath('userData')):app.getPath('userData');
    journal=new Journal(storage);
    process.on('uncaughtException',error=>{journal.write('launcher error',{error:String(error.stack??error)});dialog.showErrorBox('Something went wrong in the launcher',`${error}\n\nUse Copy report in Settings → Advanced and post it in #help on Discord.`);});
    process.on('unhandledRejection',error=>{journal.write('launcher error',{error:String((error as Error)?.stack??error)});});
    app.on('child-process-gone',(_event,details)=>journal.write('helper process gone',details as unknown as Record<string,unknown>));
    const server=await newestServer(join(process.resourcesPath,'runtime'),app.getVersion(),storage);
    runtime = new Runtime(server.root, userData, storage);
    runtime.on('event',(event,details)=>journal.write(event,details));
    await runtime.loadSettings();
    site = await gameSite(runtime,47832,(kind,message)=>{journal.write('game page '+kind,{message});runtime.reportProblem(`Game page ${kind}: ${message}`);},()=>multiplayer.reachability());
    const portableRoot=app.commandLine.getSwitchValue('portable-root'),generation=app.commandLine.getSwitchValue('launcher-generation');
    if(app.isPackaged&&(!portableRoot||!generation))throw Error('Open the top-level portable launcher; portable ownership is missing');
    const root=portableRoot?await realpath(portableRoot):undefined;
    about=await identity({launcher:app.getVersion(),server:server.version,serverRoot:server.root,folder:root??dirname(userData),storage});
    journal.write('launcher started',about);runtime.reportUpdate('Started: '+Object.entries(about).map(([key,value])=>`${key}=${value}`).join(' '));
    const appPolicy=createLauncherPolicy(process.resourcesPath,app.getVersion());
    const store=root?new LauncherStore({root,generation,installed:app.getVersion(),resources:process.resourcesPath,policy:appPolicy,native:join(root,process.platform==='win32'?'OpenRotMG Singleplayer.exe':'OpenRotMG Singleplayer')}):undefined;
    multiplayer = new Multiplayer(site,appPolicy,join(storage,'tools'),message=>runtime.reportUpdate(message,'multiplayer'));
    launcherUpdates = new LauncherUpdates(app.getVersion(),targetName(),appPolicy.request,store);
    serverUpdates = new ServerUpdates(runtime,appPolicy,storage,server.version);
    serverUpdates.on('log',message=>runtime.reportUpdate('Server: '+message));
    launcherUpdates.on('log',message=>runtime.reportUpdate('Launcher: '+message));
    await launcherUpdates.startup();
    if(root&&process.platform==='linux')await installDesktopIcon(process.env.XDG_DATA_HOME??join(app.getPath('home'),'.local/share'),join(root,'OpenRotMG Singleplayer'),join(__dirname,'assets/app-icon.png'));
    window = new BrowserWindow({ icon:join(__dirname,'assets/app-icon.png'), width: 900, height: 700, minWidth: 360, minHeight: 480, frame: false, title: 'Open RotMG Single Player',
      webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('render-process-gone',(_event,details)=>journal.write('launcher window crashed',details as unknown as Record<string,unknown>));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== index && !details.url.startsWith(pathToFileURL(__dirname + '/').href) }));
    saves = new SaveControls(runtime, {
      choose: async () => {
        const result = await dialog.showOpenDialog(window!, { title: 'Import player: choose your exported account file', properties: ['openFile'], filters: [{name: 'Portable account', extensions: ['json']}] });
        if (result.canceled) return undefined;
        if (result.filePaths.length !== 1) throw new Error('Native save chooser did not return exactly one file');
        return result.filePaths[0];
      },
      confirmRestore: async (preview, modified) => (await dialog.showMessageBox(window!, {
        type: 'warning', title: 'Replace the full local save?', message: 'Restore this backup?',
        detail: `${modified}\n${preview.account_count} accounts · ${preview.character_count} characters\nYour current save is backed up first.`,
        buttons: ['Cancel', 'Restore full local save'], defaultId: 0, cancelId: 0, noLink: true,
      })).response === 1,
      openFolder: path => shell.openPath(path),
    });
    const checked = (channel: string, action: (...args: unknown[]) => unknown, valid: (args: unknown[]) => boolean = args => args.length === 0) => ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== index || !valid(args)) throw new Error('Rejected untrusted IPC sender or arguments');
      return (async()=>{
        try{
          if(closing&&!['launcher:status','server:status','runtime:status','report:copy','window:minimize','window:maximize'].includes(channel))throw new UserNotice('The launcher is closing. Please wait.');
          if(launcherUpdates.busy&&!['launcher:status','server:status','runtime:status','window:minimize','window:maximize','report:copy','save:location',...(launcherUpdates.view().phase==='downloading'?['window:close']:[])].includes(channel))throw new UserNotice('The launcher is updating. Please wait.');
          if(launcherUpdates.view().blocked&&['runtime:start','multiplayer:host','runtime:client','runtime:bots','save:import','save:confirm-import','save:backup','save:restore','account:list','account:edit'].includes(channel))throw new UserMessage('Check launcher files in Settings → Updates before playing.');
          const started=performance.now(),value=await action(...args);
          if(journaled(channel))journal.write(channel,{ok:true,ms:Math.round(performance.now()-started)});
          return{ok:true,value};
        }
        catch(error){
          if(error instanceof UserNotice)return{ok:false,error:error.message,severity:'info'};
          runtime.reportProblem(error);
          if(error instanceof UserMessage){journal.write(channel,{ok:false,message:error.message});return{ok:false,error:error.message};}
          const found=problem(error,channel);return{ok:false,error:found.said,problem:found};
        }
      })();
    });
    checked('report:copy',()=>clipboard.writeText(report(about,lastProblem,journal,runtime.view().logs)));
    checked('window:minimize', () => window!.minimize());
    checked('window:maximize', () => { if(window!.isMaximized())window!.unmaximize();else window!.maximize(); });
    checked('window:close', () => window!.close());
    checked('runtime:status', view);
    checked('runtime:bots',enabled=>runtime.setBots(enabled as boolean),args=>args.length===1&&typeof args[0]==='boolean');
    checked('runtime:start', () => runtime.start());
    checked('launcher:status', () => launcherUpdates.view());
    checked('launcher:check', () => launcherUpdates.check());
    checked('launcher:install', async () => {
      try{
        if(serverUpdates.view().phase==='downloading')throw new UserNotice('Wait for the server update to finish.');
        requireLauncherSaveState(runtime.view());const prepared=await launcherUpdates.prepare();if(closing)throw new UserMessage('Launcher update canceled while closing.');closing=true;
        await multiplayer.stop();await Promise.all([saves.cancelImport(),runtime.close()]);requireLauncherSaveState(runtime.view(),true);await site.close();
        launcherUpdates.step('Starting authenticated update helper');await launcherUpdates.arm(prepared);quitting=true;app.exit(73);
      }catch(error){launcherUpdates.failed(error);runtime.reportProblem(error);throw error instanceof UserMessage?error:new UserMessage('The update did not finish. See Advanced → Logs.');}
      finally{closing=false;}
    });
    checked('launcher:recover', () => launcherUpdates.recover());
    checked('server:status', () => serverUpdates.view());
    checked('server:check', () => serverUpdates.check());
    checked('server:install', () => serverUpdates.install());
    checked('launcher:healthy', async () => {const operation=app.commandLine.getSwitchValue('launcher-update-health');if(operation&&launcherUpdates.view().blocked){await launcherUpdates.healthy(operation);try{await launcherUpdates.prune();}catch(error){runtime.reportProblem(new Error('Launcher update completed, but old code cleanup failed: '+String(error)));}}});
    checked('runtime:stop', () => runtime.stop());
    checked('runtime:client', async () => {
      if (runtime.view().status !== 'ready' || runtime.view().operation || runtime.view().closing) throw new Error('Server is not ready');
      await shell.openExternal(site.url());
    });
    checked('multiplayer:status', () => multiplayer.view());
    checked('multiplayer:host', async () => { if (runtime.view().status !== 'ready') await runtime.start(); return multiplayer.host(); });
    checked('multiplayer:online', () => multiplayer.online());
    checked('multiplayer:stop', () => multiplayer.stop());
    checked('multiplayer:join', address => shell.openExternal(joinURL(address as string)), args => args.length === 1 && typeof args[0] === 'string' && args[0].length <= 300);
    checked('multiplayer:copy', text => clipboard.writeText(text as string), args => args.length === 1 && typeof args[0] === 'string' && args[0].length <= 300);
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
    checked('save:restore', name => saves.restoreBackup(name as string), args => args.length === 1 && isBackupName(args[0]));
    runtime.on('change', () => {
      // Friends would otherwise keep a listener that only answers "Server is stopped".
      if (runtime.view().status !== 'ready' && multiplayer.view().phase !== 'off') void multiplayer.stop().catch(error => runtime.reportProblem(error));
      if (window && !window.isDestroyed()) window.webContents.send('runtime:changed', view());
    });
    multiplayer.on('change', view => { if (window && !window.isDestroyed()) window.webContents.send('multiplayer:changed', view); });
    launcherUpdates.on('change', view => { if (window && !window.isDestroyed()) window.webContents.send('launcher:changed',view); });
    serverUpdates.on('change', view => { if (window && !window.isDestroyed()) window.webContents.send('server:changed',view); });
    window.on('close', event => { if (!quitting) { event.preventDefault(); void close(); } });
    void window.loadURL(index);
  }).catch(error => { console.error(error);dialog.showErrorBox('The game could not open', 'Please report this with server data/launcher-console.log.\n'+String(error)); app.exit(1); });
  async function close() {
    if (closing) return;
    closing = true;
    launcherUpdates.abort();
    try { await multiplayer.stop(); const stopped = runtime.close(); await Promise.all([saves.cancelImport(), stopped]); await site.close(); quitting = true; app.quit(); }
    catch (error) {
      runtime.reportProblem(error);
      // Keep the app alive while an unconfirmed server may still be writing the save.
      if (runtime.view().pid) { dialog.showErrorBox('The game could not close normally', 'The server may still be saving. Details are in Advanced → Logs.'); return; }
      dialog.showErrorBox('The last save was not confirmed', 'The next Play backs up your save first. Details are in Advanced → Logs.');
      quitting = true; app.exit(1);
    } finally { closing = false; }
  }
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void close(); } });
  app.on('window-all-closed', () => { if (quitting) app.quit(); });
}
