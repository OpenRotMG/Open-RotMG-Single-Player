import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
const require=createRequire(import.meta.url);

for(const [name,eol] of [['LF','\n'],['CRLF','\r\n']]) {
  test(`main registered client action and real preload/renderer wiring (${name})`,async()=>{
    const source=async file=>{const text=(await readFile(file,'utf8')).replace(/\r\n/g,'\n').replace(/\n/g,eol);assert.equal(text.includes('\r\n'),name==='CRLF');return ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;};
    const runtimeExports={};runInNewContext(await source('src/runtime.ts'),{exports:runtimeExports,require});
    const origin=new runtimeExports.Runtime('/owned/resources','/owned/user').origin;assert.equal(origin,'http://127.0.0.1:47831');
    const handlers=new Map(),calls=[],elements=new Map();let ready,changed,status='stopped',pending,openedWindow;
    const view=()=>({status,origin,diagnostics:'owned',logs:[],message:'fixture'});
    const problems=[];const runtime={reportProblem:error=>problems.push(error),view,on:()=>{},origin:view().origin,clientURL:()=>view().origin+'/',userData:'/owned/user'};
    class BrowserWindow {
      constructor(){openedWindow=this;this.webContents={mainFrame:{url:pathToFileURL('/owned/dist/index.html').href},setWindowOpenHandler(){},on(){},session:{setPermissionRequestHandler(){},webRequest:{onBeforeRequest(){}}}};}
      on(){} loadURL(){} isDestroyed(){return false;}
    }
    class RuntimeUpdates{view(){return{phase:'ready',message:'Fixture, not a runtime check',canPlayInstalled:false,canRecover:false,canRetry:false};}on(){}startup(){}}
    const electron={app:{getVersion:()=> '0.1.0',setName(){},requestSingleInstanceLock:()=>true,whenReady:()=>({then:callback=>{ready=Promise.resolve().then(callback);return ready;}}),getPath:()=>'/owned/user',on(){}},BrowserWindow,ipcMain:{handle:(channel,handler)=>handlers.set(channel,handler)},shell:{openExternal:async url=>{calls.push(url);await pending;}},dialog:{showErrorBox:message=>assert.fail(message)}};
    runInNewContext(await source('src/main.ts'),{exports:{},__dirname:'/owned/dist',process:{resourcesPath:'/owned/resources'},require:id=>id==='electron'?electron:id==='./launcher-updates'?{LauncherUpdates:class{view(){return {installed:'0.1.1',phase:'idle',message:''};}abort(){}}}:id==='./game-site'?{gameSite:async()=>({url:()=>runtime.origin+'/',close:async()=>{}})}:id==='./runtime'?{Runtime:class{constructor(){return runtime;}}}:id==='./saves'?require('../dist/saves.js'):id==='./updates'?{RuntimeUpdates}:id==='./user-message'?require('../dist/user-message.js'):id==='./update-policy'?{createUpdatePolicy:()=>({baseline:{root:'/owned/resources/runtime'}})}:id==='./update-format'?require('../dist/update-format.js'):require(id)});
    await ready;
    const trusted=()=>({sender:openedWindow.webContents,senderFrame:openedWindow.webContents.mainFrame});
    const action=handlers.get('runtime:client');assert.equal(typeof action,'function');
    for(status of ['stopped','starting','stopping','failed'])assert.equal((await action(trusted())).ok,false);assert(problems.every(error=>/Server is not ready/.test(error.message)));
    assert.equal(calls.length,0);status='ready';
    for(const [event,args] of [[{...trusted(),sender:{}},[]],[{...trusted(),senderFrame:{url:trusted().senderFrame.url}},[]],[trusted(),['http://evil.invalid/']],[trusted(),[undefined]]])assert.throws(()=>action(event,...args),/Rejected untrusted IPC/);
    const frame=trusted().senderFrame,originalURL=frame.url;frame.url='file:///untrusted/index.html';assert.throws(()=>action(trusted()),/Rejected untrusted IPC/);frame.url=originalURL;
    assert.equal(calls.length,0);
    let finish;pending=new Promise(ok=>finish=ok);let settled=false;const opening=action(trusted()).then(()=>settled=true);await Promise.resolve();assert.equal(settled,false);assert.deepEqual(calls,['http://127.0.0.1:47831/']);finish();await opening;assert.equal(settled,true);
    const failure=Error('actual shell rejection');electron.shell.openExternal=async()=>{throw failure;};assert.equal((await action(trusted())).ok,false);assert.equal(problems.at(-1),failure);
    let launcher;
    const ipcRenderer={invoke:(channel,...args)=>Promise.resolve().then(()=>handlers.get(channel)(trusted(),...args)),on:(channel,callback)=>{assert(['runtime:changed','update:changed'].includes(channel));if(channel==='runtime:changed')changed=value=>callback({},value);}};
    runInNewContext(await source('src/preload.ts'),{exports:{},require:id=>{assert.equal(id,'electron');return {ipcRenderer,contextBridge:{exposeInMainWorld:(key,value)=>{assert.equal(key,'launcher');launcher=value;}}};}});
    assert(Object.isFrozen(launcher));
    const document={getElementById:id=>{if(!elements.has(id))elements.set(id,{textContent:'',disabled:false});return elements.get(id);}};
    runInNewContext(await source('src/renderer.ts'),{exports:{},URL,window:{launcher,addEventListener(){}},document});
    await new Promise(ok=>setImmediate(ok));
    for(status of ['stopped','starting','stopping','failed','ready']){changed(view());assert.equal(elements.get('client').disabled,status!=='ready');}
    elements.get('client').onclick();await new Promise(ok=>setImmediate(ok));assert.match(elements.get('error').textContent,/Open Server logs/);assert(!elements.get('error').textContent.includes('actual shell rejection'));
    electron.shell.openExternal=async url=>calls.push(url);elements.get('client').onclick();await new Promise(ok=>setImmediate(ok));assert.equal(elements.get('error').textContent,'');assert.equal(calls.at(-1),'http://127.0.0.1:47831/');
  });
}
