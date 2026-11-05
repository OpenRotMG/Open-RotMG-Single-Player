import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';

async function endpoint(child,stderr){
 const deadline=Date.now()+30_000;
 while(Date.now()<deadline){
  assert(child.exitCode===null&&child.signalCode===null,'Owned Electron exited before debugger attachment');
  const match=/Debugger listening on (ws:\/\/127\.0\.0\.1:[0-9]+\/[^\s]+)/.exec(stderr());
  if(match){const url=new URL(match[1]);assert(url.protocol==='ws:'&&url.hostname==='127.0.0.1'&&url.port&&!url.username&&!url.password&&!url.search&&!url.hash);return url.href;}
  await delay(50);
 }
 throw Error('Owned Electron main inspector did not open before startup; no fixture was injected');
}
async function inspector(url){
 const socket=new WebSocket(url);await new Promise((ok,bad)=>{socket.addEventListener('open',ok,{once:true});socket.addEventListener('error',bad,{once:true});});
 let sequence=0;const pending=new Map(),events=new EventEmitter();socket.addEventListener('message',event=>{const data=JSON.parse(event.data);if(data.id){const p=pending.get(data.id);if(p){pending.delete(data.id);data.error?p.reject(Error(JSON.stringify(data.error))):p.resolve(data.result);}}else if(data.method)events.emit(data.method,data.params);});
 socket.addEventListener('close',()=>{for(const p of pending.values())p.reject(Error('Owned Node inspector disconnected'));pending.clear();});
 const send=(method,params={})=>new Promise((resolve,reject)=>{if(socket.readyState!==WebSocket.OPEN){reject(Error('Owned Node inspector is closed'));return;}const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
 const evaluate=async(expression,contextId)=>{assert(Number.isSafeInteger(contextId),'Explicit owned main execution context required');const value=await send('Runtime.evaluate',{expression,contextId,awaitPromise:true,returnByValue:true});assert(!value.exceptionDetails,JSON.stringify(value.exceptionDetails));return value.result.value;};
 const frameEvaluate=async(expression,callFrameId)=>{const value=await send('Debugger.evaluateOnCallFrame',{expression,callFrameId,returnByValue:true});assert(!value.exceptionDetails,JSON.stringify(value.exceptionDetails));return value.result.value;};
 return{send,evaluate,frameEvaluate,on:(...args)=>events.on(...args),close:()=>socket.close()};
}
export async function launchUpdateTest({executablePath,profile,env,policy,setupMain=''}){
 const args=['--inspect-brk=0','--remote-debugging-port=0',`--user-data-dir=${profile}`,...(process.platform==='linux'?['--ozone-platform=x11']:[])];
 const child=spawn(executablePath,args,{env,stdio:['ignore','pipe','pipe'],windowsHide:true}),events=new EventEmitter();let debug,browser,mainContext,resumed=false,stderr='',stdout='';
 // Crash cuts need main's actual exit independently of inherited pipes held by a paused owned backend.
 const exited=new Promise(ok=>child.once('exit',(code,signal)=>ok({code,signal})));
 const closed=new Promise(ok=>child.once('close',(code,signal)=>{events.emit('close',{code,signal});ok({code,signal});}));let spawnError;child.once('error',error=>spawnError=error);child.stdout.on('data',bytes=>stdout+=bytes);child.stderr.on('data',bytes=>{stderr+=bytes;if(stderr.includes('Waiting for the debugger to disconnect'))debug?.close();});
 console.log(`update-test-launch spawned owned Electron pid=${child.pid}`);
 try{
  debug=await inspector(await endpoint(child,()=>stderr));
  const pauses=[],pauseLog=[],scripts=new Map();debug.on('Debugger.scriptParsed',value=>scripts.set(value.scriptId,{url:value.url,contextId:value.executionContextId}));debug.on('Debugger.paused',value=>{pauses.push(value);pauseLog.push(value.callFrames.map(frame=>({url:frame.url,scriptId:frame.location.scriptId,line:frame.location.lineNumber})));});
  await debug.send('Runtime.enable');await debug.send('Debugger.enable');console.log('update-test-launch inspector attached before startup');
  await debug.send('Debugger.setBreakpointByUrl',{urlRegex:'app\\.asar[/\\\\]dist[/\\\\]main\\.js$',lineNumber:0});await debug.send('Runtime.runIfWaitingForDebugger');
  let atMain=false,mainFrame;const deadline=Date.now()+30000;
  while(Date.now()<deadline){if(pauses.length){const pause=pauses.shift();mainFrame=pause.callFrames.find(frame=>/app\.asar[/\\]dist[/\\]main\.js$/.test(frame.url||scripts.get(frame.location.scriptId)?.url||''));if(mainFrame){atMain=true;mainContext=scripts.get(mainFrame.location.scriptId)?.contextId;break;}await debug.send('Debugger.resume');}else await delay(20);}
  console.log(`update-test-launch main breakpoint=${atMain}`);
  assert(atMain,`Owned packaged main did not pause before execution: pauses=${JSON.stringify(pauseLog)}, scripts=${JSON.stringify([...scripts.values()].filter(script=>script.url.includes('app.asar')))}; ${stderr}`);
  const script=`(()=>{
    if(process.pid!==${child.pid}||!process.argv.includes(${JSON.stringify(`--user-data-dir=${profile}`)}))throw Error('Refusing a foreign main inspector/profile/PID');
    const require=process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app.asar/dist/main.js');
    const fs=require('node:fs');if(fs.realpathSync(process.execPath)!==fs.realpathSync(${JSON.stringify(resolve(executablePath))}))throw Error('Refusing a foreign Electron executable');
    const policyPath=require.resolve(process.resourcesPath+'/app.asar/dist/update-policy.js'),mainPath=require.resolve(process.resourcesPath+'/app.asar/dist/main.js'),beforeMain=!require.cache[policyPath]&&(!require.cache[mainPath]||!require.cache[mainPath].loaded);
    if(!beforeMain)throw Error('Packaged update policy was already loaded before fixture attachment');
    const fixture=${JSON.stringify(policy)},module=require(policyPath);module.createUpdatePolicy=(_resources,launcher)=>({...fixture,launcher,request:fetch});
    globalThis.runtimeUpdateTest={beforeMain:true,pid:process.pid,allowedFiles:[],choices:[],confirms:[],external:[],dialogs:[]};
    const electron=require('electron'),originalOpen=electron.dialog.showOpenDialog,originalMessage=electron.dialog.showMessageBox;
    electron.dialog.showOpenDialog=async(window,options)=>{
      if(!['Import player — choose exported account','Restore full local backup'].includes(options.title))return originalOpen(window,options);
      const state=globalThis.runtimeUpdateTest,chosen=state.choices.shift();if(chosen===undefined)throw Error('No declared chooser fixture');
      if(chosen===null)return{canceled:true,filePaths:[]};if(!state.allowedFiles.includes(chosen))throw Error('Undeclared chooser path');return{canceled:false,filePaths:[chosen]};
    };
    electron.dialog.showMessageBox=async(window,options)=>{
      if(!['Local runtime recovery/update','Replace the full local save?'].includes(options.title))return originalMessage(window,options);
      const state=globalThis.runtimeUpdateTest,response=state.confirms.shift();if(![0,1].includes(response))throw Error('No declared native confirmation');state.dialogs.push({title:options.title,message:options.message,detail:options.detail,response});return{response};
    };
    electron.dialog.showErrorBox=(title,detail)=>globalThis.runtimeUpdateTest.dialogs.push({kind:'error',title,detail});
    electron.shell.openExternal=async url=>{globalThis.runtimeUpdateTest.external.push(url);};
    ${setupMain}
    return{pid:process.pid,execPath:process.execPath,argv:process.argv,resources:process.resourcesPath,beforeMain};
  })()`;
  assert(Number.isSafeInteger(mainContext),'Actual main context was not observed');
  const proof=await debug.frameEvaluate(script,mainFrame.callFrameId);assert(proof.beforeMain);console.log('update-test-launch fixture attached before main');resumed=true;await debug.send('Debugger.resume');console.log('update-test-launch main resumed');
  const chromeDeadline=Date.now()+30000;while(!stderr.includes('DevTools listening on ')&&Date.now()<chromeDeadline&&child.exitCode===null)await delay(50);assert(stderr.includes('DevTools listening on '),`Owned Electron Chromium inspector missing: ${stderr}`);
  const chromeURL=new URL(/DevTools listening on (ws:\/\/127\.0\.0\.1:[0-9]+\/devtools\/browser\/[^\s]+)/.exec(stderr)?.[1]);assert(chromeURL.hostname==='127.0.0.1'&&!chromeURL.search&&!chromeURL.hash);
  browser=await chromium.connectOverCDP(chromeURL.href);console.log('update-test-launch Chromium attached');
  const app={
   process:()=>child,
   evaluate:(fn,arg)=>debug.evaluate(`(${fn.toString()})(process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app.asar/dist/main.js')('electron'),${JSON.stringify(arg)})`,mainContext),
   firstWindow:async()=>{const context=browser.contexts()[0];return context.pages()[0]??context.waitForEvent('page',{timeout:30000});},
   waitForEvent:async name=>{assert(['close','exit'].includes(name));return name==='exit'?exited:closed;},
   detach:async()=>{assert(child.exitCode!==null||child.signalCode!==null,'Detach requires actual owned main exit');debug.close();await browser.close();},
   // app.exit can close inspector before replying; only actual owned main exit settles that race.
   close:async()=>{try{await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());}catch(error){if(child.exitCode===null&&child.signalCode===null){const timer=new AbortController();try{await Promise.race([exited,delay(5000,undefined,{signal:timer.signal}).then(()=>{throw error;})]);}finally{timer.abort();}}}return closed;},
   stderr:()=>stderr,stdout:()=>stdout,
  };
  assert.equal(await app.evaluate(()=>process.pid),child.pid);return{app,proof};
 }catch(error){
  if(resumed&&debug){await debug.evaluate("process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app.asar/dist/main.js')('electron').app.quit()",mainContext).catch(()=>undefined);await closed;}
  else{debug?.close();if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await closed;}
  throw new Error(`${String(spawnError??error)}\nOwned launcher diagnostics: ${stderr}`);
 }
}
