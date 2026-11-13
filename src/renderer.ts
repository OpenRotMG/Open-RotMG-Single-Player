import type { View } from './runtime';
import type { ImportPreview, SaveResult, BackupFile, LocalAccount } from './saves';
import type { UpdateView, RuntimeSummary } from './updates';
import type { LauncherUpdateView } from './launcher-updates';
declare global {
  interface Window { launcher: {
    minimize():Promise<void>; maximize():Promise<void>; close():Promise<void>;
    status():Promise<View>; start():Promise<void>; startInstalled():Promise<void>; stop():Promise<void>; client():Promise<void>; help():Promise<void>;
    launcherUpdates():Promise<LauncherUpdateView>; checkLauncher():Promise<LauncherUpdateView>; installLauncher():Promise<void>; recoverLauncher():Promise<LauncherUpdateView>; launcherHealthy():Promise<void>; launcherChanged(callback:(view:LauncherUpdateView)=>void):void;
    updates():Promise<UpdateView>; checkUpdates():Promise<UpdateView>; retryUpdate():Promise<UpdateView>; recoverRuntime():Promise<UpdateView>; releases():Promise<void>; updatesChanged(callback:(view:UpdateView)=>void):void;
    importPlayer():Promise<ImportPreview|undefined>; confirmImport(expected:string,replace:boolean):Promise<SaveResult|undefined>; cancelImport():Promise<boolean>;
    listAccounts():Promise<LocalAccount[]>;editAccount(account:number,expected:string,username:string,password:string):Promise<LocalAccount[]>;
    makeBackup():Promise<SaveResult>; listBackups():Promise<BackupFile[]>; saveLocation():Promise<string>; openSaveFolder():Promise<SaveResult>; openBackupFolder():Promise<SaveResult>; restoreBackup(name?:string):Promise<SaveResult|undefined>;
    changed(callback:(view:View)=>void):void;
  } }
}
const element = <T extends HTMLElement>(id:string):T => { const node=document.getElementById(id);if(!node)throw Error('Missing launcher control: '+id);return node as T; };
const button = (id:string) => element<HTMLButtonElement>(id);
const pages=['accounts','backups','updates','advanced'] as const;
type Page = 'home'|typeof pages[number];
let page:Page='home',runtimeView:View|undefined,updateView:UpdateView|undefined,launcherView:LauncherUpdateView|undefined;
let preview:ImportPreview|undefined,requesting=false,submitting=false,actionError='',backups:BackupFile[]=[],selectedBackup:string|undefined,backupRequest=0;
const statusMessages:Record<View['status'],string>={stopped:'Stopped',starting:'Preparing game…',ready:'Running',stopping:'Saving…',failed:'Save unconfirmed'};
function updateMessage(){
  const u=updateView;if(!u)return 'Loading…';
  if(u.needsStart)return 'Play will prepare the game.';
  const messages:Record<UpdateView['phase'],string>={initializing:'Loading…',checking:'Checking…',downloading:'Downloading update…',staged:'Update downloaded. Save and stop to prepare it.',activating:'Backing up and preparing…',ready:'Up to date.',unavailable:'Cannot connect. Try again.',service:'Could not check. Try again.',rejected:'Update could not be verified. See Advanced → Logs.',launcher:'A newer launcher is required.',recovery:'Check your save before continuing.',canceled:'Canceled. Play when you are ready.'};
  // Playable readiness alone says nothing about whether the public release was checked.
  return u.phase==='ready'?(u.message==='Matches the published server + client release.'?'Up to date.':u.installed?.kind==='source'?'Source build.':'Ready.'):messages[u.phase];
}
function renderLogs(){
  const technical=element<HTMLInputElement>('technical').checked;
  const lines=technical?[runtimeView?.message,updateView?.message,launcherView?.message,...(runtimeView?.logs??[]),actionError]:[runtimeView?statusMessages[runtimeView.status]:'Loading…',updateMessage(),launcherView?.message,actionError];
  const query=element<HTMLInputElement>('log-search').value.toLowerCase(),problems=element<HTMLSelectElement>('log-filter').value==='problems';
  const selected=lines.filter((line):line is string=>Boolean(line)).join('\n').split('\n').filter(line=>line.toLowerCase().includes(query)&&(!problems||/error|fail|warn|unverified|refus|reject|unknown/i.test(line)));
  element('logs').textContent=selected.length?selected.join('\n'):'No matching events.';
}
// These signed historical manifests predate authenticated commit-count metadata.
const commitNumbers:Record<string,number>={'2c700135d755a4210c2204334aafee2572205ec1':2542,'d3016983e6fa807be8bf700001e0ba2cf0fc2a7e':88};
const commitNumber=(sha:string,count?:number)=>count!==undefined?`commit #${count}`:Object.hasOwn(commitNumbers,sha)?`commit #${commitNumbers[sha]}`:'commit number unavailable';
const runtimeSummary=(value:RuntimeSummary)=>`${value.version}${value.kind==='source'?' (source build)':''}\nServer ${commitNumber(value.server,value.serverCount)} · Client ${commitNumber(value.client,value.clientCount)}`;
function render(){
  const v=runtimeView,u=updateView,busy=requesting||Boolean(launcherView?.blocked)||['downloading','installing'].includes(launcherView?.phase??'')||!v||Boolean(v.operation)||v.closing||['starting','stopping'].includes(v.status);
  const recovery=u?.phase==='recovery'||u?.phase==='initializing'||v?.status==='failed';
  button('play').disabled=busy||recovery||!u;
  button('play').textContent=v?.status==='starting'?'Preparing…':v?.status==='ready'?'Open game':u?.canPlayInstalled?'Play installed game':'Play';
  element('message').textContent=v?.closing?'Saving and closing…':v?.status==='failed'||u?.phase==='recovery'?'Last save unconfirmed.':v?.status==='starting'?'Checking your save…':v?.status==='stopping'?'Saving your progress…':u?.needsStart?'Play will prepare the game.':!u||u.phase==='initializing'?'Loading…':'';
  element('progress').hidden=!v||!['starting','stopping'].includes(v.status);
  button('home-recovery').hidden=!u?.canRecover;button('home-recovery').disabled=busy||v?.pid!==undefined;
  button('home-stop').hidden=v?.status!=='ready';button('home-stop').disabled=busy;
  button('start').disabled=busy||v?.status!=='stopped'||recovery;
  button('stop').disabled=busy||!v||!['starting','ready'].includes(v.status);
  button('client').disabled=busy||v?.status!=='ready';
  const saveBlocked=busy||!v||!['stopped','ready'].includes(v.status)||!u?.canManageSaves;
  for(const id of ['import','backup','folder','restore-other','save-folder'])button(id).disabled=saveBlocked;
  button('load-accounts').disabled=saveBlocked;
  button('load-accounts').textContent=v?.status==='ready'?'Save & load accounts':'Refresh accounts';
  element('account-list').querySelectorAll<HTMLInputElement|HTMLButtonElement>('input,button').forEach(control=>{control.disabled=saveBlocked;});
  button('restore').disabled=saveBlocked||!selectedBackup;
  button('check-updates').disabled=busy||!u||['initializing','checking','downloading','activating'].includes(u.phase);
  button('play-installed').hidden=!u?.canPlayInstalled;button('play-installed').disabled=busy||v?.status!=='stopped';
  button('retry-update').hidden=!u?.canRetry;button('retry-update').disabled=busy||v?.status!=='stopped';
  button('recover-runtime').hidden=!u?.canRecover;button('recover-runtime').disabled=busy||!v||!['stopped','failed'].includes(v.status)||v.pid!==undefined;
  button('runtime-releases').hidden=u?.phase!=='launcher';button('runtime-releases').disabled=Boolean(v?.closing);
  button('check-launcher').disabled=requesting||!launcherView||launcherView.phase==='checking'||Boolean(v?.closing);
  button('download-launcher').hidden=launcherView?.phase!=='available';button('download-launcher').disabled=requesting||Boolean(v?.closing);
  element('launcher-update-steps').hidden=launcherView?.phase!=='available';
  button('recover-launcher').hidden=!launcherView?.blocked;button('recover-launcher').disabled=requesting||Boolean(v?.closing);
  if(launcherView?.blocked)element('home-result').textContent='Check launcher files in Settings → Updates.';
  else if(element('home-result').textContent==='Check launcher files in Settings → Updates.')element('home-result').textContent='';
  element('status').textContent=v?statusMessages[v.status]:'Loading…';
  element('diagnostics').textContent=v?.diagnostics??'';
  const link=element<HTMLAnchorElement>('client-url');link.hidden=v?.status!=='ready'||!v.clientURL;link.textContent=v?.clientURL?new URL(v.clientURL).origin+'/':'';link.href=link.textContent;
  element('update-version').textContent=u?.installed?.version??'';
  element('update-installed').textContent=u?.installed?`Installed: ${runtimeSummary(u.installed)}`:'Checking…';
  element('update-available').textContent=u?.available?`Available: ${runtimeSummary(u.available)}`:'';
  element('update-message').textContent=updateMessage();
  element('launcher-version').textContent=launcherView?.installed??'';
  const launcherMessages:Record<LauncherUpdateView['phase'],string>={idle:'',checking:'Checking…',error:'Update did not finish. See Advanced → Logs.',available:'Update available.',current:'Up to date.',downloading:'Downloading and checking…',installing:'Saving and reopening…',recovery:'Check launcher files before playing.'};
  element('launcher-update-message').textContent=launcherView?launcherMessages[launcherView.phase]:'';
  if(v?.closing||(submitting&&!v?.operation))hidePreview();
  renderLogs();
}
function reportError(error:unknown){actionError=String(error);const message=error instanceof Error?error.message:String(error);element('error').textContent=message;element('import-error').textContent=message;renderLogs();}
async function invoke(action:()=>Promise<unknown>){
  if(requesting)return;
  requesting=true;actionError='';element('error').textContent='';element('import-error').textContent='';render();
  try{await action();}catch(error){reportError(error);}finally{requesting=false;render();}
}
function showPage(next:Page){
  element('account-list').replaceChildren();
  page=next;element('home-page').hidden=page!=='home';element('settings-page').hidden=page==='home';
  for(const name of pages){element(`${name}-page`).hidden=page!==name;button(`tab-${name}`).setAttribute('aria-selected',String(page===name));button(`tab-${name}`).tabIndex=page===name?0:-1;}
  button('show-home').setAttribute('aria-current',page==='home'?'page':'false');button('show-settings').setAttribute('aria-current',page!=='home'?'page':'false');
  if(page==='backups')void refreshBackups().catch(reportError);
  if(page==='accounts')element('accounts-status').textContent=runtimeView?.status==='ready'?'Save & load accounts to manage local logins.':'Refresh accounts to view local logins.';
}
async function refreshBackups(){
  const request=++backupRequest,files=await window.launcher.listBackups();if(request!==backupRequest)return;
  backups=files;if(!files.some(file=>file.name===selectedBackup))selectedBackup=files[0]?.name;
  const list=element('backup-list');list.replaceChildren();
  for(const file of files){
    const row=document.createElement('tr'),select=document.createElement('td'),date=document.createElement('td'),name=document.createElement('td'),radio=document.createElement('input');
    radio.type='radio';radio.name='backup';radio.checked=file.name===selectedBackup;radio.setAttribute('aria-label',`${new Date(file.modified).toLocaleString()} · ${file.name}`);
    const choose=()=>{radio.checked=true;selectedBackup=file.name;render();};radio.onchange=choose;row.onclick=choose;select.append(radio);
    date.textContent=new Date(file.modified).toLocaleString();name.textContent='Other file';
    for(const [part,label] of [['manual','Manual backup'],['pre-import','Before import'],['pre-replace','Before replacement'],['pre-restore','Before restore'],['pre-update','Before update'],['pre-start','Before starting'],['pre-account-edit','Before account change'],['recovery-current','After save check']])if(file.name.includes(`-${part}-`)){name.textContent=label;break;}
    row.setAttribute('data-backup',file.name);name.title=`${file.name} · ${file.bytes} bytes`;row.append(select,date,name);list.append(row);
  }
  element('backup-empty').hidden=files.length>0;element('backup-empty').textContent='No backups yet.';render();
}
function hidePreview(){preview=undefined;const modal=element<HTMLDialogElement>('import-preview');if(modal.open)modal.close();}
async function play(installed=false){if(runtimeView?.status!=='ready'){if(installed)await window.launcher.startInstalled();else await window.launcher.start();}await window.launcher.client();}
function result(value:SaveResult|undefined,target='save-result'){if(value){element(target).textContent=[value.message,value.disclosure].filter(Boolean).join('\n');element(target).title=value.path??'';}}
async function saveAction(action:()=>Promise<SaveResult|undefined>,target='save-result'){element(target).textContent='';result(await action(),target);await refreshBackups();}
button('show-home').onclick=()=>showPage('home');button('show-settings').onclick=()=>showPage('backups');button('show-backups').onclick=()=>showPage('backups');button('show-advanced').onclick=()=>showPage('advanced');
for(const name of pages){button(`tab-${name}`).onclick=()=>showPage(name);button(`tab-${name}`).onkeydown=event=>{const index=pages.indexOf(name),next=event.key==='ArrowRight'?(index+1)%pages.length:event.key==='ArrowLeft'?(index+pages.length-1)%pages.length:event.key==='Home'?0:event.key==='End'?pages.length-1:undefined;if(next!==undefined){event.preventDefault();showPage(pages[next]);button(`tab-${pages[next]}`).focus();}};}
button('play').onclick=()=>void invoke(()=>play(Boolean(updateView?.canPlayInstalled)));
button('start').onclick=()=>void invoke(()=>window.launcher.start());
for(const id of ['stop','home-stop'])button(id).onclick=()=>void invoke(async()=>{await window.launcher.stop();element('home-result').textContent='Saved and stopped.';await refreshBackups();});
button('client').onclick=()=>void invoke(()=>window.launcher.client());
element('client-url').onclick=event=>{event.preventDefault();void invoke(()=>window.launcher.client());};
button('help').onclick=()=>void invoke(()=>window.launcher.help());
element('export-account').onclick=event=>{event.preventDefault();void invoke(()=>window.launcher.help());};
function renderAccounts(accounts:LocalAccount[]){
  const list=element('account-list');list.replaceChildren();
  element('accounts-status').textContent=accounts.length?'':'No local accounts yet. Play or import an account first.';
  for(const account of accounts){
    const form=document.createElement('form'),title=document.createElement('h4'),userLabel=document.createElement('label'),passwordLabel=document.createElement('label'),username=document.createElement('input'),password=document.createElement('input'),show=document.createElement('button'),save=document.createElement('button'),hint=document.createElement('p');
    form.className='account';form.setAttribute('data-account',String(account.account));title.textContent=account.name;
    userLabel.textContent='Username (email)';username.type='email';username.required=true;username.maxLength=245;username.autocomplete='off';username.value=account.username??'';userLabel.append(username);
    passwordLabel.textContent='Password';password.type='password';password.required=account.username===null;password.autocomplete='new-password';password.maxLength=128;password.value=account.password??'';passwordLabel.append(password);
    hint.textContent=account.username===null?'Guest account. Set a username and password to sign in.':account.password===null?'Password not saved. Leave blank to keep it, or enter a new password.':'';
    show.type='button';show.textContent='Show password';show.onclick=()=>{password.type=password.type==='password'?'text':'password';show.textContent=password.type==='password'?'Show password':'Hide password';};
    save.type='submit';save.textContent='Save changes';form.append(title,userLabel,passwordLabel,show,save,hint);
    form.onsubmit=event=>{event.preventDefault();void invoke(async()=>{const rows=await window.launcher.editAccount(account.account,account.expected,username.value,password.value);password.value='';renderAccounts(rows);element('imported-account').hidden=true;element('accounts-status').textContent='Account updated. Your progress is unchanged.';await refreshBackups();});};
    list.append(form);
  }
}
button('load-accounts').onclick=()=>void invoke(async()=>{renderAccounts(await window.launcher.listAccounts());await refreshBackups();});
button('import').onclick=()=>void invoke(async()=>{
  hidePreview();const selected=await window.launcher.importPlayer();if(!selected)return;
  preview=selected;element('import-summary').textContent=`${selected.name} · ${selected.character_count} characters · ${new Date(selected.exported_at*1000).toLocaleDateString()}`;
  element<HTMLInputElement>('local-login').value=selected.login;element('replace-warning').hidden=!selected.replaced;
  element<HTMLDialogElement>('import-preview').showModal();button('import-cancel').focus();
});
button('import-confirm').onclick=()=>void invoke(async()=>{
  if(!preview||submitting)return;const selected=preview;submitting=true;button('import-confirm').disabled=true;button('import-cancel').disabled=true;
  try{const imported=await window.launcher.confirmImport(selected.expected,selected.replaced);hidePreview();if(imported){element('account-login').textContent=imported.login!;element('imported-account').hidden=false;showPage('home');element('home-result').textContent='Account imported.';await refreshBackups();}}
  finally{submitting=false;button('import-confirm').disabled=false;button('import-cancel').disabled=false;}
});
const cancelImport=()=>void invoke(async()=>{if(submitting)return;const canceled=await window.launcher.cancelImport();hidePreview();if(!canceled)throw Error('Import was already submitted. Check its outcome in Advanced → Logs before trying again.');});
button('import-cancel').onclick=cancelImport;element<HTMLDialogElement>('import-preview').oncancel=event=>{event.preventDefault();cancelImport();};
button('backup').onclick=()=>void invoke(()=>saveAction(()=>window.launcher.makeBackup()));
button('folder').onclick=()=>void invoke(()=>saveAction(()=>window.launcher.openBackupFolder()));
button('save-folder').onclick=()=>void invoke(()=>saveAction(()=>window.launcher.openSaveFolder(),'location-result'));
button('restore').onclick=()=>void invoke(async()=>{if(!selectedBackup||!backups.some(file=>file.name===selectedBackup))throw Error('Choose a backup first.');const restored=await window.launcher.restoreBackup(selectedBackup);result(restored);if(restored)element('imported-account').hidden=true;await refreshBackups();});
button('restore-other').onclick=()=>void invoke(async()=>{const restored=await window.launcher.restoreBackup();result(restored);if(restored)element('imported-account').hidden=true;await refreshBackups();});
button('check-updates').onclick=()=>void invoke(async()=>{updateView=await window.launcher.checkUpdates();});
button('play-installed').onclick=()=>void invoke(async()=>{showPage('home');await play(true);});
button('retry-update').onclick=()=>void invoke(async()=>{updateView=await window.launcher.retryUpdate();});
for(const id of ['recover-runtime','home-recovery'])button(id).onclick=()=>void invoke(async()=>{updateView=await window.launcher.recoverRuntime();await refreshBackups();});
button('runtime-releases').onclick=()=>void invoke(()=>window.launcher.releases());
button('check-launcher').onclick=()=>void invoke(async()=>{launcherView=await window.launcher.checkLauncher();});
button('download-launcher').onclick=()=>void invoke(()=>window.launcher.installLauncher());
button('recover-launcher').onclick=()=>void invoke(async()=>{launcherView=await window.launcher.recoverLauncher();element('home-result').textContent='Launcher files checked. You can play.';});
for(const id of ['technical','log-filter','log-search'])element(id).addEventListener(id==='log-search'?'input':'change',renderLogs);
button('copy-logs').onclick=()=>void invoke(async()=>{try{await navigator.clipboard.writeText(element('logs').textContent!);element('copy-result').textContent='Log copied.';}catch(error){element('copy-result').textContent='Could not copy. Select the log text and copy it.';throw error;}});
for(const [id,action] of [['minimize',()=>window.launcher.minimize()],['maximize',()=>window.launcher.maximize()],['close-window',()=>window.launcher.close()]] as const)button(id).onclick=()=>void action().catch(reportError);
window.launcher.changed(view=>{runtimeView=view;render();});window.launcher.updatesChanged(view=>{updateView=view;render();});window.launcher.launcherChanged(view=>{launcherView=view;render();});
void invoke(async()=>{runtimeView=await window.launcher.status();updateView=await window.launcher.updates();launcherView=await window.launcher.launcherUpdates();element('save-location').textContent=await window.launcher.saveLocation();await window.launcher.launcherHealthy();});
