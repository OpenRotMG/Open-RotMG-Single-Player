import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Runtime } from './runtime';

app.setName('Open RotMG Single Player');
// Chromium's singleton lock is tied to this persistent userData directory, not the install path.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window: BrowserWindow | undefined;
  let runtime: Runtime;
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
    const checked = (channel: string, action: () => unknown) => ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== index || args.length !== 0) throw new Error('Rejected untrusted IPC sender or arguments');
      return action();
    });
    checked('runtime:status', () => runtime.view());
    checked('runtime:start', () => runtime.start());
    checked('runtime:stop', () => runtime.stop());
    checked('runtime:client', async () => {
      if (runtime.view().status !== 'ready') throw new Error('Server is not ready');
      await shell.openExternal(runtime.origin + '/');
    });
    checked('runtime:help', () => shell.openExternal('https://github.com/OpenRotMG/Open-RotMG-Single-Player'));
    runtime.on('change', view => { if (window && !window.isDestroyed()) window.webContents.send('runtime:changed', view); });
    window.on('close', event => { if (!quitting) { event.preventDefault(); void close(); } });
    void window.loadURL(index);
  }).catch(error => { dialog.showErrorBox('Launcher startup failed', String(error)); app.exit(1); });
  async function close() {
    if (closing) return;
    closing = true;
    try { await runtime.stop(); await runtime.verifyFailureGate(); quitting = true; app.quit(); }
    catch (error) {
      try { await runtime.verifyFailureGate(); }
      catch (persistenceError) {
        dialog.showErrorBox('Failure gate was NOT recorded', `${String(persistenceError)}\nThe launcher will remain open and retain ownership. Preserve the save and diagnostics; no durable failure gate or save success is claimed.`);
        return;
      }
      // Keep the app and ownership alive while an unverified child may still be draining.
      dialog.showErrorBox('Shutdown was not verified', `${String(error)}\nNo process was force-killed. Inspect ${runtime.diagnostics}. Save mutations are blocked. You may quit after the server exits, but no save success is claimed.`);
      if (!runtime.view().pid) { quitting = true; app.exit(1); }
    } finally { closing = false; }
  }
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void close(); } });
  app.on('window-all-closed', () => { if (quitting) app.quit(); });
}
