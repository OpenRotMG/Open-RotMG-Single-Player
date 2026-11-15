import type { View } from './runtime';
import type { ImportPreview, SaveResult, BackupFile, LocalAccount } from './saves';
import type { LauncherUpdateView } from './launcher-updates';
import type { ServerUpdateView } from './server-updates';
declare global {
  interface Window { launcher: {
    copyLogs(text:string):Promise<void>;
    minimize():Promise<void>; maximize():Promise<void>; close():Promise<void>;
    status():Promise<View>; setBots(enabled:boolean):Promise<void>; start():Promise<void>; stop():Promise<void>; client():Promise<void>; help():Promise<void>;
    launcherUpdates():Promise<LauncherUpdateView>; checkLauncher():Promise<LauncherUpdateView>; installLauncher():Promise<void>; recoverLauncher():Promise<LauncherUpdateView>; launcherHealthy():Promise<void>; launcherChanged(callback:(view:LauncherUpdateView)=>void):void;
    serverUpdates():Promise<ServerUpdateView>; checkServer():Promise<ServerUpdateView>; installServer():Promise<ServerUpdateView>; serverChanged(callback:(view:ServerUpdateView)=>void):void;
    importPlayer():Promise<ImportPreview|undefined>; confirmImport(expected:string,password:string,confirmation:string,replace:boolean):Promise<SaveResult|undefined>; cancelImport():Promise<boolean>;
    listAccounts():Promise<LocalAccount[]>;editAccount(account:number,expected:string,username:string,password:string):Promise<LocalAccount[]>;
    makeBackup():Promise<void>; listBackups():Promise<BackupFile[]>; saveLocation():Promise<string>; openSaveFolder():Promise<void>; openBackupFolder():Promise<void>; restoreBackup(name:string):Promise<void>;
    changed(callback:(view:View)=>void):void;
  } }
}
const element = <T extends HTMLElement>(id:string):T => { const node=document.getElementById(id);if(!node)throw Error('Missing launcher control: '+id);return node as T; };
const button = (id:string) => element<HTMLButtonElement>(id);
const pages=['accounts','backups','updates','advanced'] as const;
type Page = 'home'|typeof pages[number];
let page:Page='home',runtimeView:View|undefined,launcherView:LauncherUpdateView|undefined,serverView:ServerUpdateView|undefined;
let preview:ImportPreview|undefined,requesting=false,submitting=false,actionError='',backups:BackupFile[]=[],selectedBackup:string|undefined,backupRequest=0;
function renderLogs(){
  const lines=[runtimeView?.message,serverView?.message,launcherView?.message,...(runtimeView?.logs??[]),actionError];
  const query=element<HTMLInputElement>('log-search').value.toLowerCase();
  const selected=lines.filter((line):line is string=>Boolean(line)).join('\n').split('\n').filter(line=>line.toLowerCase().includes(query));
  element('logs').textContent=selected.length?selected.join('\n'):'No matching events.';
}
function render(){
  const v=runtimeView,busy=requesting||Boolean(launcherView?.blocked)||['downloading','installing'].includes(launcherView?.phase??'')||!v||Boolean(v.operation)||v.closing||['starting','stopping'].includes(v.status);
  const failed=v?.status==='failed';
  button('play').disabled=busy||failed;
  button('play').textContent=v?.status==='starting'?'Preparing…':v?.status==='ready'?'Open game':'Play';
  element('message').textContent=v?.closing?'Saving and closing…':failed?'Last save unconfirmed. Reopen the launcher.':v?.status==='starting'?'Backing up your save and preparing the world…':v?.status==='stopping'?'Saving your progress…':!v?'Loading…':'';
  element('progress').hidden=!v||!['starting','stopping'].includes(v.status);
  button('home-stop').hidden=v?.status!=='ready';button('home-stop').disabled=busy;
  if(!requesting)element<HTMLInputElement>('bots-enabled').checked=v?.botsEnabled===true;
  element<HTMLInputElement>('bots-enabled').disabled=busy||v?.status!=='stopped';
  const saveBlocked=busy||!v||!['stopped','ready'].includes(v.status);
  for(const id of ['accounts-import','backup','folder','save-folder'])button(id).disabled=saveBlocked;
  button('load-accounts').disabled=saveBlocked;
  button('load-accounts').textContent=v?.status==='ready'?'Save & load accounts':'Refresh accounts';
  element('account-list').querySelectorAll<HTMLInputElement|HTMLButtonElement>('input,button').forEach(control=>{control.disabled=saveBlocked;});
  button('restore').disabled=saveBlocked||!selectedBackup;
  button('check-launcher').disabled=busy||!launcherView||launcherView.phase==='checking';
  button('download-launcher').hidden=launcherView?.phase!=='available';button('download-launcher').disabled=requesting||Boolean(v?.closing);
  button('recover-launcher').hidden=!launcherView?.blocked;button('recover-launcher').disabled=requesting||Boolean(v?.closing);
  element('launcher-version').textContent=launcherView?.installed??'';
  const s=serverView,serverBusy=Boolean(s&&['checking','downloading'].includes(s.phase));
  element('server-version').textContent=s?.installed??'';element('server-update-message').textContent=s?.message??'';
  button('check-server').disabled=busy||serverBusy;button('install-server').hidden=s?.phase!=='available';button('install-server').disabled=busy||serverBusy;
  const serverBar=element<HTMLProgressElement>('server-progress'),p=s?.progress;serverBar.hidden=s?.phase!=='downloading'||!p;if(p?.completed!==undefined&&p.total!==undefined){serverBar.max=p.total;serverBar.value=p.completed;}else serverBar.removeAttribute('value');
  const launcherMessages:Record<LauncherUpdateView['phase'],string>={idle:'',checking:'Checking…',error:'Update did not finish. See Advanced → Logs.',available:'Update available.',current:'Up to date.',downloading:'Downloading and checking…',installing:'Saving and reopening…',recovery:'Check launcher files before playing.'};
  element('launcher-update-message').textContent=launcherView?(['checking','downloading','installing','error'].includes(launcherView.phase)?launcherView.message:launcherMessages[launcherView.phase]):'';
  const value=launcherView?.progress,bar=element<HTMLProgressElement>('launcher-progress');bar.hidden=!launcherView||!['checking','downloading','installing'].includes(launcherView.phase)||!value;if(value&&value.completed!==undefined&&value.total!==undefined){bar.max=value.total;bar.value=value.completed;}else bar.removeAttribute('value');
  if(v?.closing||(submitting&&!v?.operation))hidePreview();
  renderLogs();
}
function reportError(error:unknown){const notice=error as {name?:unknown;message?:unknown}|null,info=notice?.name==='Notice'&&typeof notice.message==='string';actionError=info?'':String(error);element('error').setAttribute('class',info?'notice info':'notice error');element('error').setAttribute('role',info?'status':'alert');const message=info?notice!.message as string:error instanceof Error?error.message:String(error);element('error').textContent=message;element('import-error').textContent=message;renderLogs();}
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
  if(page==='backups'&&!['downloading','installing'].includes(launcherView?.phase??''))void refreshBackups().catch(reportError);
  if(page==='accounts'){element('accounts-status').textContent='';if(runtimeView?.status==='stopped'&&!button('load-accounts').disabled)void invoke(async()=>renderAccounts(await window.launcher.listAccounts()));}
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
    for(const [part,label] of [['manual','Manual backup'],['pre-import','Before import'],['pre-replace','Before replacement'],['pre-restore','Before restore'],['pre-update','Before update'],['pre-start','Before starting'],['pre-account-edit','Before account change']])if(file.name.includes(`-${part}-`)){name.textContent=label;break;}
    row.setAttribute('data-backup',file.name);name.title=`${file.name} · ${file.bytes} bytes`;row.append(select,date,name);list.append(row);
  }
  element('backup-empty').hidden=files.length>0;element('backup-empty').textContent='No backups yet.';render();
}
function hidePreview(){preview=undefined;for(const id of ['import-password','import-confirmation'])element<HTMLInputElement>(id).value='';const modal=element<HTMLDialogElement>('import-preview');if(modal.open)modal.close();}
async function play(){if(runtimeView?.status!=='ready')await window.launcher.start();await window.launcher.client();}
button('import').onclick=()=>showPage('accounts');
button('show-home').onclick=()=>showPage('home');button('show-settings').onclick=()=>showPage('backups');button('show-backups').onclick=()=>showPage('backups');button('show-updates').onclick=()=>showPage('updates');
for(const name of pages){button(`tab-${name}`).onclick=()=>showPage(name);button(`tab-${name}`).onkeydown=event=>{const index=pages.indexOf(name),next=event.key==='ArrowRight'?(index+1)%pages.length:event.key==='ArrowLeft'?(index+pages.length-1)%pages.length:event.key==='Home'?0:event.key==='End'?pages.length-1:undefined;if(next!==undefined){event.preventDefault();showPage(pages[next]);button(`tab-${pages[next]}`).focus();}};}
button('play').onclick=()=>void invoke(play);
element<HTMLInputElement>('bots-enabled').onchange=event=>{const enabled=(event.target as HTMLInputElement).checked;void invoke(async()=>{await window.launcher.setBots(enabled);runtimeView=await window.launcher.status();});};
button('home-stop').onclick=()=>void invoke(async()=>{await window.launcher.stop();await refreshBackups();});
button('help').onclick=()=>void invoke(()=>window.launcher.help());
element('export-account').onclick=event=>{event.preventDefault();void invoke(()=>window.launcher.help());};
function renderAccounts(accounts:LocalAccount[]){
  if(page!=='accounts')return;
  const list=element('account-list');list.replaceChildren();
  element('accounts-status').textContent=accounts.length?'':'No local accounts yet. Play or import an account first.';
  for(const account of accounts){
    const form=document.createElement('form'),title=document.createElement('h4'),userLabel=document.createElement('label'),passwordLabel=document.createElement('label'),field=document.createElement('div'),username=document.createElement('input'),password=document.createElement('input'),show=document.createElement('button'),save=document.createElement('button');
    form.className='account';form.setAttribute('data-account',String(account.account));title.textContent=account.name;
    userLabel.textContent='Username (email)';username.type='email';username.required=true;username.maxLength=245;username.autocomplete='off';username.value=account.username??'';userLabel.append(username);
    passwordLabel.textContent='New password';password.id=passwordLabel.htmlFor=`account-${account.account}-password`;password.type='password';password.required=account.username===null;password.autocomplete='new-password';password.maxLength=128;password.value='';password.placeholder=account.username===null?'Choose a password':'Leave blank to keep';field.className='password-field';field.append(password,show);
    show.type='button';show.textContent='👁';show.setAttribute('aria-label','Show password');show.setAttribute('aria-pressed','false');show.onclick=()=>{const visible=password.type==='password';password.type=visible?'text':'password';show.setAttribute('aria-label',(visible?'Hide':'Show')+' password');show.setAttribute('aria-pressed',String(visible));};
    save.type='submit';save.textContent='Save changes';form.append(title,userLabel,passwordLabel,field,save);
    form.onsubmit=event=>{event.preventDefault();void invoke(async()=>{const rows=await window.launcher.editAccount(account.account,account.expected,username.value,password.value);password.value='';renderAccounts(rows);element('accounts-status').textContent='';await refreshBackups();});};
    list.append(form);
  }
}
button('load-accounts').onclick=()=>void invoke(async()=>{renderAccounts(await window.launcher.listAccounts());await refreshBackups();});
button('accounts-import').onclick=()=>void invoke(async()=>{
  hidePreview();const selected=await window.launcher.importPlayer();if(!selected)return;
  preview=selected;element('import-summary').textContent=`${selected.name} · ${selected.character_count} characters · ${new Date(selected.exported_at*1000).toLocaleDateString()}`;
  element('local-login').textContent=selected.login;element('replace-warning').hidden=!selected.replaced;
  for(const [id,label]of [['import-password','password'],['import-confirmation','confirm password']]){element<HTMLInputElement>(id).value='password';element<HTMLInputElement>(id).type='password';button('show-'+id).setAttribute('aria-pressed','false');button('show-'+id).setAttribute('aria-label','Show '+label);}
  element<HTMLDialogElement>('import-preview').showModal();button('import-cancel').focus();
});
button('import-confirm').onclick=()=>void invoke(async()=>{
  if(!preview||submitting)return;const selected=preview;submitting=true;button('import-confirm').disabled=true;button('import-cancel').disabled=true;
  try{const imported=await window.launcher.confirmImport(selected.expected,element<HTMLInputElement>('import-password').value,element<HTMLInputElement>('import-confirmation').value,selected.replaced);hidePreview();if(imported){renderAccounts(await window.launcher.listAccounts());element('accounts-status').textContent='Account imported.';await refreshBackups();}}
  finally{submitting=false;button('import-confirm').disabled=false;button('import-cancel').disabled=false;}
});
for(const [buttonId,inputId,label]of [['show-import-password','import-password','password'],['show-import-confirmation','import-confirmation','confirm password']])button(buttonId).onclick=()=>{const input=element<HTMLInputElement>(inputId),show=input.type==='password';input.type=show?'text':'password';button(buttonId).setAttribute('aria-label',(show?'Hide ':'Show ')+label);button(buttonId).setAttribute('aria-pressed',String(show));};
const cancelImport=()=>void invoke(async()=>{if(submitting)return;const canceled=await window.launcher.cancelImport();hidePreview();if(!canceled)throw Error('Import was already submitted. See Advanced → Logs.');});
button('import-cancel').onclick=cancelImport;element<HTMLDialogElement>('import-preview').oncancel=event=>{event.preventDefault();cancelImport();};
button('backup').onclick=()=>void invoke(async()=>{await window.launcher.makeBackup();await refreshBackups();});
button('folder').onclick=()=>void invoke(()=>window.launcher.openBackupFolder());
button('save-folder').onclick=()=>void invoke(()=>window.launcher.openSaveFolder());
button('restore').onclick=()=>void invoke(async()=>{if(!selectedBackup)throw Error('Choose a backup first.');await window.launcher.restoreBackup(selectedBackup);await refreshBackups();});
button('check-server').onclick=()=>void invoke(async()=>{serverView=await window.launcher.checkServer();});
button('install-server').onclick=()=>void invoke(async()=>{serverView=await window.launcher.installServer();});
button('check-launcher').onclick=()=>void invoke(async()=>{launcherView=await window.launcher.checkLauncher();});
button('download-launcher').onclick=()=>void invoke(()=>window.launcher.installLauncher());
button('recover-launcher').onclick=()=>void invoke(async()=>{launcherView=await window.launcher.recoverLauncher();});
element('log-search').addEventListener('input',renderLogs);
button('copy-logs').onclick=()=>void window.launcher.copyLogs(element('logs').textContent!).catch(reportError);
for(const [id,action] of [['minimize',()=>window.launcher.minimize()],['maximize',()=>window.launcher.maximize()],['close-window',()=>window.launcher.close()]] as const)button(id).onclick=()=>void action().catch(reportError);
window.launcher.changed(view=>{runtimeView=view;render();});window.launcher.serverChanged(view=>{serverView=view;render();});window.launcher.launcherChanged(view=>{launcherView=view;render();});
void invoke(async()=>{runtimeView=await window.launcher.status();launcherView=await window.launcher.launcherUpdates();serverView=await window.launcher.serverUpdates();element('save-location').textContent=await window.launcher.saveLocation();await window.launcher.launcherHealthy();});
