import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { join } from 'node:path';
import {realpath} from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Runtime } from './runtime';
import { SaveControls, isBackupName } from './saves';
import { RuntimeUpdates } from './updates';
import { createUpdatePolicy } from './update-policy';
import { LauncherUpdates } from './launcher-updates';
import { RELEASES_PAGE,targetName } from './update-format';
import { gameSite } from './game-site';
import {UserMessage} from './user-message';

app.setName('Open RotMG Single Player');
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
  const view = () => ({...runtime.view(),clientURL:runtime.view().status==='ready'?site.url():undefined});
  let quitting = false, closing = false;
  const index = pathToFileURL(join(__dirname, 'index.html')).href;
  const importPassword = 'password';
  app.whenReady().then(async () => {
    const policy = createUpdatePolicy(process.resourcesPath, app.getVersion());
    const userData=process.platform==='win32'?await realpath(app.getPath('userData')):app.getPath('userData');
    runtime = new Runtime(policy.baseline.root, userData);
    site = await gameSite(runtime);
    launcherUpdates = new LauncherUpdates(app.getVersion(),targetName());
    window = new BrowserWindow({ width: 900, height: 700, minWidth: 360, minHeight: 480, frame: false, title: 'Open RotMG Single Player',
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
      if (!window || closing || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== index || !valid(args)) throw new Error('Rejected untrusted IPC sender or arguments');
      return (async()=>{
        try{return{ok:true,value:await action(...args)};}
        catch(error){runtime.reportProblem(error);return{ok:false,error:error instanceof UserMessage?error.message:'This action did not finish. See Advanced → Logs for details.'};}
      })();
    });
    checked('window:minimize', () => window!.minimize());
    checked('window:maximize', () => { if(window!.isMaximized())window!.unmaximize();else window!.maximize(); });
    checked('window:close', () => window!.close());
    checked('runtime:status', view);
    checked('runtime:start', () => runtime.start());
    checked('runtime:start-installed', () => {
      if(!updates.view().canPlayInstalled)throw new Error('Explicit installed-version play requires a rejected/unavailable check, verified stopped selection and no pending ambiguity');
      return runtime.start(true);
    });
    checked('launcher:status', () => launcherUpdates.view());
    checked('launcher:check', () => launcherUpdates.check());
    checked('launcher:download', () => shell.openExternal(launcherUpdates.download()));
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
    checked('save:import', () => saves.beginImport());
    checked('save:confirm-import', (expected, replace) => saves.finishImport(expected, importPassword, importPassword, replace), args => args.length === 2 && typeof args[0] === 'string' && /^[a-f0-9]{64}$/.test(args[0]) && typeof args[1] === 'boolean');
    checked('save:cancel-import', () => saves.cancelImport());
    checked('save:backup', () => saves.makeBackup());
    checked('save:folder', () => saves.openBackupFolder());
    checked('save:list', () => saves.listBackups());
    checked('save:location', () => runtime.userData);
    checked('save:open-location', () => saves.openSaveFolder());
    checked('save:restore', name => saves.restoreBackup(name as string | undefined), args => args.length === 0 || args.length === 1 && isBackupName(args[0]));
    runtime.on('change', () => { if (window && !window.isDestroyed()) window.webContents.send('runtime:changed', view()); });
    updates.on('change', view => { if (window && !window.isDestroyed()) window.webContents.send('update:changed', view); });
    void updates.startup();
    window.on('close', event => { if (!quitting) { event.preventDefault(); void close(); } });
    void window.loadURL(index);
  }).catch(error => { console.error(error);dialog.showErrorBox('The game could not open', 'Keep your player data folder. Please report this problem with the error details from the terminal.'); app.exit(1); });
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
