import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const source=async name=>ts.transpileModule(await readFile(`src/${name}.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
async function setup(){
 const handlers=new Map(),calls=[],windowListeners=new Map();let window,ready,closingResolve;
 const runtime={view:()=>({status:'stopped',logs:[],closing:false}),on(){},resources:'/owned/runtime',userData:'/owned/user',origin:'http://127.0.0.1:47831',clientURL:()=> 'http://127.0.0.1:47831/',start:async(...args)=>calls.push(['start',...args]),close:async()=>calls.push(['close']),verifyFailureGate:async()=>{}};
 class BrowserWindow{constructor(){window=this;this.webContents={mainFrame:{url:pathToFileURL('/owned/dist/index.html').href},setWindowOpenHandler(){},on(){},session:{setPermissionRequestHandler(){},webRequest:{onBeforeRequest(){}}}};}on(name,callback){windowListeners.set(name,callback);}loadURL(){}isDestroyed(){return false;}}
 class SaveControls{constructor(){ }beginImport(){calls.push(['import']);}finishImport(...args){calls.push(['confirm',...args]);return 'actual outcome';}cancelImport(){calls.push(['cancel']);}makeBackup(){calls.push(['backup']);}openBackupFolder(){calls.push(['folder']);}restoreBackup(){calls.push(['restore']);}}
 const updateView={phase:'ready',message:'Fixture, not a real update check',canPlayInstalled:false,canRecover:false,canRetry:false};
 class RuntimeUpdates{view(){return updateView;}on(){}startup(){}check(){calls.push(['update-check']);return updateView;}retry(){calls.push(['update-retry']);return updateView;}recover(){calls.push(['update-recover']);return updateView;}}
 const electron={app:{getVersion:()=> '0.1.0',setName(){},requestSingleInstanceLock:()=>true,whenReady:()=>({then:callback=>{ready=Promise.resolve().then(callback);return ready;}}),getPath:()=>'/owned/user',on(){},quit(){calls.push(['quit']);},exit:code=>calls.push(['exit',code])},BrowserWindow,ipcMain:{handle:(name,callback)=>handlers.set(name,callback)},shell:{openExternal:async url=>calls.push(['external',url])},dialog:{showErrorBox:(...args)=>calls.push(['error',...args])}};
 runInNewContext(await source('main'),{exports:{},Buffer,__dirname:'/owned/dist',process:{resourcesPath:'/owned/resources'},require:id=>id==='electron'?electron:id==='./launcher-updates'?{LauncherUpdates:class{view(){return {installed:'0.1.1',phase:'idle',message:''};}check(){calls.push(['launcher-check']);return this.view();}download(){return 'https://github.com/OpenRotMG/Open-RotMG-Single-Player/releases/download/v0.1.2/openrotmg-singleplayer-0.1.2-linux-x64.zip';}abort(){}}}:id==='./game-site'?{gameSite:async()=>({url:()=>runtime.clientURL(),close:async()=>{}})}:id==='./runtime'?{Runtime:class{constructor(){return runtime;}}}:id==='./saves'?{SaveControls}:id==='./updates'?{RuntimeUpdates}:id==='./update-policy'?{createUpdatePolicy:()=>({baseline:{root:'/owned/resources/runtime'}})}:id==='./update-format'?require('../dist/update-format.js'):require(id)});await ready;
 const trusted=()=>({sender:window.webContents,senderFrame:window.webContents.mainFrame});
 return {handlers,calls,runtime,trusted,window,windowListeners,updateView};
}
test('main named save/update IPC validates exact sender/frame/index and arguments before side effects',async()=>{
 const f=await setup();
 for(const name of ['save:import','save:backup','save:folder','save:restore','save:cancel-import','launcher:status','launcher:check','launcher:download','update:status','update:check','update:retry','update:recover','update:releases','runtime:start-installed']){
  const action=f.handlers.get(name);assert.equal(typeof action,'function');
  for(const [event,args] of [[{...f.trusted(),sender:{}},[]],[{...f.trusted(),senderFrame:{url:f.trusted().senderFrame.url}},[]],[f.trusted(),['/arbitrary/path']],[f.trusted(),[undefined]]])assert.throws(()=>action(event,...args),/Rejected untrusted IPC/);
  const frame=f.trusted().senderFrame,original=frame.url;frame.url='file:///evil/index.html';assert.throws(()=>action(f.trusted()),/Rejected/);frame.url=original;
 }
 const confirm=f.handlers.get('save:confirm-import'),token='a'.repeat(64),valid=[token,'private-new-password','private-new-password',false];
 for(const args of [[],valid.slice(0,3),[...valid,'extra'],['x',...valid.slice(1)],[token,{},'x',false],[token,'x'.repeat(129),'x',false],[token,'abcde','abcde','true'],[token,'é'.repeat(65),'abcde',false]])assert.throws(()=>confirm(f.trusted(),...args),/Rejected/);
 assert.throws(()=>confirm({...f.trusted(),sender:{}},...valid),/Rejected/);assert.deepEqual(f.calls,[]);
 assert.equal(confirm(f.trusted(),...valid),'actual outcome');assert.deepEqual(f.calls,[['confirm',...valid]]);
});
test('main import help is a fixed export URL; renderer cannot select external destinations',async()=>{
 const f=await setup();await f.handlers.get('runtime:help')(f.trusted());assert.deepEqual(f.calls,[['external','https://openrotmg.org/export/']]);
 assert.throws(()=>f.handlers.get('runtime:help')(f.trusted(),'https://evil.invalid'),/Rejected/);
});
test('main Close takes lifecycle ownership and cancels preview before admitting any further IPC',async()=>{
 const f=await setup();let release,closed=false;f.runtime.close=()=>{closed=true;return new Promise(ok=>release=ok);};
 f.windowListeners.get('close')({preventDefault(){}});assert(closed);assert.throws(()=>f.handlers.get('save:import')(f.trusted()),/Rejected/);assert.deepEqual(f.calls,[['cancel']]);
 release();await new Promise(ok=>setImmediate(ok));assert.deepEqual(f.calls,[['cancel'],['quit']]);
});
test('launcher checks and downloads use distinct named handlers and the fixed platform ZIP, not renderer-selected URLs',async()=>{
 const f=await setup();await f.handlers.get('launcher:check')(f.trusted());await f.handlers.get('launcher:download')(f.trusted());
 assert.deepEqual(f.calls,[['launcher-check'],['external','https://github.com/OpenRotMG/Open-RotMG-Single-Player/releases/download/v0.1.2/openrotmg-singleplayer-0.1.2-linux-x64.zip']]);
});
test('preload exposes only named operations, never renderer paths, commands or arbitrary URLs',async()=>{
 let bridge;const calls=[];
 runInNewContext(await source('preload'),{exports:{},require:id=>{assert.equal(id,'electron');return{contextBridge:{exposeInMainWorld:(name,value)=>{assert.equal(name,'launcher');bridge=value;}},ipcRenderer:{invoke:(...args)=>{calls.push(args);return Promise.resolve();},on(){}}};}});
 assert(Object.isFrozen(bridge));assert.deepEqual(Object.keys(bridge),['status','start','startInstalled','launcherUpdates','checkLauncher','downloadLauncher','updates','checkUpdates','retryUpdate','recoverRuntime','releases','stop','client','help','importPlayer','confirmImport','cancelImport','makeBackup','openBackupFolder','restoreBackup','updatesChanged','changed']);
 await bridge.importPlayer();await bridge.confirmImport('a'.repeat(64),'secret','secret',false);await bridge.makeBackup();await bridge.restoreBackup();await bridge.openBackupFolder();
 assert.deepEqual(calls.map(row=>row[0]),['save:import','save:confirm-import','save:backup','save:restore','save:folder']);
});
test('main explicit installed mode is not an arbitrary Start argument or pending-update bypass; release URL is fixed',async()=>{
 const f=await setup(),installed=f.handlers.get('runtime:start-installed');assert.throws(()=>installed(f.trusted()),/requires a rejected\/unavailable check/);
 assert.throws(()=>f.handlers.get('runtime:start')(f.trusted(),true),/Rejected untrusted IPC/);
 f.updateView.canPlayInstalled=true;await installed(f.trusted());assert.deepEqual(f.calls,[['start',true]]);
 await f.handlers.get('update:releases')(f.trusted());assert.deepEqual(f.calls.at(-1),['external','https://github.com/OpenRotMG/Open-RotMG-Single-Player/releases']);
 assert.throws(()=>f.handlers.get('update:releases')(f.trusted(),'https://evil.invalid/installer'),/Rejected/);
 for(const name of ['update:check','update:retry','update:recover'])await f.handlers.get(name)(f.trusted());assert.deepEqual(f.calls.slice(-3),[['update-check'],['update-retry'],['update-recover']]);
});
