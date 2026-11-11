import type { View } from './runtime';
import type { ImportPreview, SaveResult } from './saves';
import type { UpdateView, RuntimeSummary } from './updates';
import type { LauncherUpdateView } from './launcher-updates';
declare global {
  interface Window { launcher: {
    status(): Promise<View>; start(): Promise<void>; startInstalled():Promise<void>; stop(): Promise<void>; client(): Promise<void>; help(): Promise<void>;
    launcherUpdates():Promise<LauncherUpdateView>;checkLauncher():Promise<LauncherUpdateView>;downloadLauncher():Promise<void>;
    updates():Promise<UpdateView>;checkUpdates():Promise<UpdateView>;retryUpdate():Promise<UpdateView>;recoverRuntime():Promise<UpdateView>;releases():Promise<void>;updatesChanged(callback:(view:UpdateView)=>void):void;
    importPlayer(): Promise<ImportPreview | undefined>; confirmImport(expected: string, password: string, confirmation: string, replace: boolean): Promise<SaveResult | undefined>; cancelImport(): Promise<boolean>;
    makeBackup(): Promise<SaveResult>; openBackupFolder(): Promise<SaveResult>; restoreBackup(): Promise<SaveResult | undefined>;
    changed(callback: (view: View) => void): void;
  } }
}
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const start = element<HTMLButtonElement>('start'), stop = element<HTMLButtonElement>('stop'), client = element<HTMLButtonElement>('client');
const password = element<HTMLInputElement>('password'), confirmation = element<HTMLInputElement>('confirmation');
let preview: ImportPreview | undefined;
let submitting = false;
let runtimeView:View|undefined, updateView:UpdateView|undefined,launcherView:LauncherUpdateView|undefined;
function clearPasswords() { password.value = ''; confirmation.value = ''; }
function render(view: View) {
  runtimeView=view;
  element('status').textContent = view.status.toUpperCase();
  element('message').textContent = view.operation ? `${view.operation}: ${view.message}` : view.status==='ready'?'Your server is ready.':view.message;
  element('diagnostics').textContent = `Detailed logs: ${view.diagnostics}`;
  element('logs').textContent = view.logs.join('\n');
  const link=element<HTMLAnchorElement>('client-url');
  link.hidden=view.status!=='ready'||!view.clientURL;
  link.textContent=view.clientURL?new URL(view.clientURL).origin+'/':'';
  link.href=link.textContent;
  const busy = !!view.operation || view.closing;
  if (view.closing || (submitting && !view.operation)) hidePreview();
  start.disabled = busy || view.status !== 'stopped';
  stop.disabled = busy || !['starting', 'ready'].includes(view.status);
  client.disabled = busy || view.status !== 'ready';
  for (const id of ['import', 'backup', 'folder', 'restore']) element<HTMLButtonElement>(id).disabled = busy || !['stopped', 'ready'].includes(view.status);
  updateButtons();
  if(launcherView)renderLauncher(launcherView);
}
function updateButtons(){
  const v=runtimeView,u=updateView,busy=!v||!!v.operation||v.closing||['starting','stopping'].includes(v.status);
  if(v){
    const recovery=u?.phase==='recovery'||u?.phase==='initializing';start.disabled=busy||v.status!=='stopped'||recovery;
    for(const id of ['import','backup','folder','restore'])element<HTMLButtonElement>(id).disabled=busy||!['stopped','ready'].includes(v.status)||recovery;
  }
  element<HTMLButtonElement>('check-updates').disabled=busy||!u||['initializing','checking','downloading','activating'].includes(u.phase);
  element<HTMLButtonElement>('play-installed').hidden=!u?.canPlayInstalled;
  element<HTMLButtonElement>('play-installed').disabled=busy||v?.status!=='stopped';
  element<HTMLButtonElement>('retry-update').hidden=!u?.canRetry;
  element<HTMLButtonElement>('retry-update').disabled=busy||v?.status!=='stopped';
  element<HTMLButtonElement>('recover-runtime').hidden=!u?.canRecover;
  element<HTMLButtonElement>('recover-runtime').disabled=busy||!v||!['stopped','failed'].includes(v.status)||v.pid!==undefined;
  element<HTMLButtonElement>('runtime-releases').hidden=u?.phase!=='launcher';
  element<HTMLButtonElement>('runtime-releases').disabled=!!v?.closing;
}
// The historical release omitted counts; retain its verified labels without an online lookup.
const commitNumbers:Record<string,number>={'2c700135d755a4210c2204334aafee2572205ec1':2542,'d3016983e6fa807be8bf700001e0ba2cf0fc2a7e':88};
const commitNumber=(sha:string,count?:number)=>count!==undefined?`commit #${count}`:Object.hasOwn(commitNumbers,sha)?`commit #${commitNumbers[sha]}`:'commit number unavailable';
function runtimeSummary(value:RuntimeSummary){return `${value.version}${value.kind==='source'?' (source build)':''}\nServer ${commitNumber(value.server,value.serverCount)} · Client ${commitNumber(value.client,value.clientCount)}`;}
function renderUpdates(view:UpdateView){
  updateView=view;
  element('update-installed').textContent=view.installed?`Installed: ${runtimeSummary(view.installed)}`:'Installed: checking…';
  element('update-available').textContent=view.available?`Available: ${runtimeSummary(view.available)}`:'';
  element('update-message').textContent=`${view.phase.toUpperCase()}: ${view.message}`;
  element('update-message').className=['service','rejected','launcher','recovery'].includes(view.phase)?'error':'hint';updateButtons();
}
function renderLauncher(view:LauncherUpdateView){
  launcherView=view;element('launcher-version').textContent=`Installed: ${view.installed}`;
  element('launcher-update-message').textContent=view.message;
  element('launcher-update-message').className=view.phase==='error'?'error':'hint';
  element<HTMLButtonElement>('check-launcher').disabled=view.phase==='checking'||!!runtimeView?.closing;
  element<HTMLButtonElement>('download-launcher').hidden=view.phase!=='available';
  element<HTMLButtonElement>('download-launcher').disabled=!!runtimeView?.closing;
  element('launcher-update-steps').hidden=view.phase!=='available';
}
const invoke = (action: () => Promise<unknown>) => { element('error').textContent = ''; void action().catch(error => { element('error').textContent = String(error); }); };
function result(value: SaveResult | undefined) {
  if (value) element('save-result').textContent = [value.message, value.disclosure, value.path].filter(Boolean).join('\n');
}
function hidePreview() { preview = undefined; clearPasswords(); element('import-preview').hidden = true; }
function showPage(page:'home'|'settings'|'logs') {
  for(const name of ['home','settings','logs']) element(`${name}-page`).hidden=name!==page;
  if(page!=='settings')clearPasswords();
}
element('show-home').onclick=()=>showPage('home');
element('show-settings').onclick=()=>showPage('settings');
element('show-logs').onclick=()=>showPage('logs');
element('client-url').onclick=event=>{event.preventDefault();invoke(()=>window.launcher.client());};
start.onclick = () => invoke(() => window.launcher.start());
stop.onclick = () => invoke(() => window.launcher.stop());
client.onclick = () => invoke(() => window.launcher.client());
element('help').onclick = () => invoke(() => window.launcher.help());
element('import').onclick = () => invoke(async () => {
  hidePreview(); element('save-result').textContent = '';
  const selected = await window.launcher.importPlayer();
  if (!selected) return;
  preview = selected; clearPasswords();
  element('import-summary').textContent = `${selected.name} · exported ${new Date(selected.exported_at * 1000).toISOString()} · ${selected.character_count} owned characters (including dead/deleted)\n${selected.disclosure}`;
  element<HTMLInputElement>('local-login').value = selected.login;
  element('replace-warning').hidden = !selected.replaced;
  element('import-confirm').textContent = selected.replaced ? 'Back up and replace this player' : 'Import player';
  element('import-preview').hidden = false;
});
element('import-confirm').onclick = () => invoke(async () => {
  if (!preview || submitting) return;
  const selected = preview;
  submitting = true;
  element<HTMLButtonElement>('import-confirm').disabled = true;
  element<HTMLButtonElement>('import-cancel').disabled = true;
  let outcome: Promise<SaveResult | undefined>;
  try {
    outcome = window.launcher.confirmImport(selected.expected, password.value, confirmation.value, selected.replaced);
    clearPasswords();
    result(await outcome); hidePreview();
  } finally {
    clearPasswords(); submitting = false;
    element<HTMLButtonElement>('import-confirm').disabled = false;
    element<HTMLButtonElement>('import-cancel').disabled = false;
  }
});
element('import-cancel').onclick = () => invoke(async () => {
  if (submitting) return;
  clearPasswords(); const canceled = await window.launcher.cancelImport(); hidePreview();
  if (!canceled) throw new Error('No pending preview was canceled. The import may already have completed; inspect its outcome before trying again.');
});
const saveAction = (action: () => Promise<SaveResult | undefined>) => invoke(async () => { element('save-result').textContent = ''; result(await action()); });
element('backup').onclick = () => saveAction(() => window.launcher.makeBackup());
element('folder').onclick = () => saveAction(() => window.launcher.openBackupFolder());
element('restore').onclick = () => saveAction(() => window.launcher.restoreBackup());
window.addEventListener('pagehide', clearPasswords);
element('check-updates').onclick=()=>invoke(async()=>renderUpdates(await window.launcher.checkUpdates()));
element('play-installed').onclick=()=>invoke(()=>window.launcher.startInstalled());
element('retry-update').onclick=()=>invoke(async()=>renderUpdates(await window.launcher.retryUpdate()));
element('recover-runtime').onclick=()=>invoke(async()=>renderUpdates(await window.launcher.recoverRuntime()));
element('runtime-releases').onclick=()=>invoke(()=>window.launcher.releases());
element('check-launcher').onclick=()=>invoke(async()=>{
  renderLauncher({installed:launcherView!.installed,phase:'checking',message:'Checking launcher releases…'});
  renderLauncher(await window.launcher.checkLauncher());
});
element('download-launcher').onclick=()=>invoke(()=>window.launcher.downloadLauncher());
window.launcher.changed(render);
window.launcher.updatesChanged(renderUpdates);
invoke(async () => {render(await window.launcher.status());renderUpdates(await window.launcher.updates());renderLauncher(await window.launcher.launcherUpdates());});
