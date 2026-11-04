import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Runtime } from './runtime';
import { SaveControls } from './saves';

app.setName('Open RotMG Single Player');
// Chromium's singleton lock is tied to this persistent userData directory, not the install path.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window: BrowserWindow | undefined;
  let runtime: Runtime;
  let saves: SaveControls;
  let quitting = false, closing = false;
  const index = pathToFileURL(join(__dirname, 'index.html')).href;
  app.whenReady().then(() => {
    runtime = new Runtime(join(process.resourcesPath, 'runtime'), app.getPath('userData'));
    window = new BrowserWindow({ width: 900, height: 700, title: 'Open RotMG Single Player',
      webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== index && !details.url.startsWith(pathToFileURL(__dirname + '/').href) }));
    saves = new SaveControls(runtime, {
      choose: async (kind, directory) => {
        const result = await dialog.showOpenDialog(window!, { title: kind === 'account' ? 'Import player — choose exported account' : 'Restore full local backup', defaultPath: kind === 'snapshot' ? directory : undefined, properties: ['openFile'], filters: kind === 'account' ? [{name: 'Portable account', extensions: ['json']}] : [{name: 'Full local backup', extensions: ['sqlite', 'db']}] });
        if (result.canceled) return undefined;
        if (result.filePaths.length !== 1) throw new Error('Native save chooser did not return exactly one file');
        return result.filePaths[0];
      },
      confirmRestore: async (preview, path, modified) => (await dialog.showMessageBox(window!, {
        type: 'warning', title: 'Replace the full local save?', message: 'Restore all local accounts and original passwords?',
        detail: `${path}\nFile modified: ${modified}\nSchema ${preview.schema} · ${preview.account_count} accounts · ${preview.character_count} characters\nAll current local progress and credentials will be replaced. A separate verified pre-restore backup must succeed first.`,
        buttons: ['Cancel', 'Restore full local save'], defaultId: 0, cancelId: 0, noLink: true,
      })).response === 1,
      openFolder: path => shell.openPath(path),
    });
    const checked = (channel: string, action: (...args: unknown[]) => unknown, valid: (args: unknown[]) => boolean = args => args.length === 0) => ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!window || closing || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== index || !valid(args)) throw new Error('Rejected untrusted IPC sender or arguments');
      return action(...args);
    });
    checked('runtime:status', () => runtime.view());
    checked('runtime:start', () => runtime.start());
    checked('runtime:stop', () => runtime.stop());
    checked('runtime:client', async () => {
      if (runtime.view().status !== 'ready' || runtime.view().operation || runtime.view().closing) throw new Error('Server is not ready');
      await shell.openExternal(runtime.origin + '/');
    });
    checked('runtime:help', () => shell.openExternal('https://openrotmg.org/export/'));
    checked('save:import', () => saves.beginImport());
    checked('save:confirm-import', (expected, password, confirmation, replace) => saves.finishImport(expected, password, confirmation, replace), args => args.length === 4 && typeof args[0] === 'string' && /^[a-f0-9]{64}$/.test(args[0]) && typeof args[1] === 'string' && Buffer.byteLength(args[1]) <= 128 && typeof args[2] === 'string' && Buffer.byteLength(args[2]) <= 128 && typeof args[3] === 'boolean');
    checked('save:cancel-import', () => saves.cancelImport());
    checked('save:backup', () => saves.makeBackup());
    checked('save:folder', () => saves.openBackupFolder());
    checked('save:restore', () => saves.restoreBackup());
    runtime.on('change', view => { if (window && !window.isDestroyed()) window.webContents.send('runtime:changed', view); });
    window.on('close', event => { if (!quitting) { event.preventDefault(); void close(); } });
    void window.loadURL(index);
  }).catch(error => { dialog.showErrorBox('Launcher startup failed', String(error)); app.exit(1); });
  async function close() {
    if (closing) return;
    closing = true;
    try { const stopped = runtime.close(); await Promise.all([saves.cancelImport(), stopped]); quitting = true; app.quit(); }
    catch (error) {
      if (runtime.view().status !== 'failed') {
        dialog.showErrorBox('Close canceled', `${String(error)}\nThe launcher remains open. No save success is claimed. Inspect the operation error before closing or trying again.`);
        return;
      }
      try { await runtime.verifyFailureGate(); }
      catch (persistenceError) {
        dialog.showErrorBox('Failure gate was NOT recorded', `${String(persistenceError)}\nThe launcher will remain open and retain ownership. Preserve the save and diagnostics; no durable failure gate or save success is claimed.`);
        return;
      }
      // Keep the app and ownership alive while an unverified child may still be draining.
      dialog.showErrorBox('An operation was not verified', `${String(error)}\nNo process was force-killed. Inspect ${runtime.diagnostics} and shutdown-failed.json. Save mutations are blocked. You may quit after the server exits, but no save success is claimed.`);
      if (!runtime.view().pid) { quitting = true; app.exit(1); }
    } finally { closing = false; }
  }
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void close(); } });
  app.on('window-all-closed', () => { if (quitting) app.quit(); });
}
