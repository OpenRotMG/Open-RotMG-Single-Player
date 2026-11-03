import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,readdir,lstat,realpath,open} from 'node:fs/promises';
import {join,resolve,win32} from 'node:path';
import {windowsPowerShellExecutable,windowsProcessIdentity} from './native-boundaries.mjs';
import {assertOwnedWindowsProcess} from './windows-owned-offline.mjs';
import {sha256} from './assets.mjs';

export function windowsStateReadDeniedMode(args,platform,arch,github,browser,extraArgs) {
  const selected=args.includes('--windows-state-read-denied');
  if(selected){assert(platform==='win32'&&arch==='x64'&&github==='true','Read-denied fixture requires native Windows x64 GitHub Actions');assert.deepEqual(args,['--windows-state-read-denied'],'Read-denied mode is an exclusive focused case');assert(!browser,'Read-denied case must not select a game browser');assert.deepEqual(extraArgs,[],'No browser flags in permission fixture');}
  return selected;
}
export function requireReadDeny(before,after,sid) {
  assert.equal(after.length,before.length,'Every owned ACL needs exact readback');
  for(const entry of before){const actual=after.find(item=>item.path===entry.path);assert(actual,'Missing ACL readback');const rules=actual.aces.filter(ace=>ace.sid===sid&&ace.type==='Deny');assert.equal(rules.length,1,'Exactly one SID-scoped read deny required');const rule=rules[0];assert.equal(rule.mask,1,'Only READ_DATA/LIST_DIRECTORY; no Synchronize, traversal or READ_CONTROL');assert.equal(rule.propagation,0);assert.equal(rule.inherited,entry.path!==before[0].path);assert.equal(rule.inheritance,entry.directory?3:0);}
}
export function requireRestoredAcls(before,after) {
  assert.equal(after.length,before.length);for(const entry of before)assert.equal(after.find(item=>item.path===entry.path)?.sddl,entry.sddl,`Original ACL must be restored: ${entry.path}`);
}
export async function stateReadDeniedLifecycle(record,operations) {
  const fail=(stage,error)=>record.errors.push({stage,message:String(error.stack??error)});
  try{await operations.exercise();}catch(error){fail('exercise',error);}
  for(const stage of ['drain','restore','serverExit','probeRestored','stateUnchanged','close','imagesExited'])try{await operations[stage]();}catch(error){fail(stage,error);}
  record.cleanupPending=record.aclApplied===true&&record.aclRestored!==true||record.imagesExited!==true;
  if(record.cleanupPending)fail('cleanup',Error('Owned ACL or image cleanup remains unverified'));
  record.status=record.errors.length?'failed':'passed';
  if(record.errors.length)throw new AggregateError(record.errors.map(item=>Error(`${item.stage}: ${item.message}`)),'Windows read-denied case or cleanup failed');
}
async function statePaths(root) {
  const paths=[];
  const visit=async path=>{const info=await lstat(path);assert(!info.isSymbolicLink(),'Owned state must not contain links');paths.push(path);if(info.isDirectory())for(const name of (await readdir(path)).sort())await visit(join(path,name));else assert(info.isFile(),'Only regular synthetic state files supported');};
  assert.equal((await realpath(root)).toLowerCase(),resolve(root).toLowerCase(),'Owned state root must not redirect');await visit(root);return paths;
}
async function stateSnapshot(root) {
  const files={};for(const path of await statePaths(root)){const info=await lstat(path);if(info.isFile())files[path.slice(root.length+1)]={sha256:sha256(await readFile(path)),size:info.size,ino:info.ino,dev:info.dev};}
  assert(files['game.db'],'Authoritative fixture DB missing');assert(files['state.lock'],'Synthetic lock missing');
  return {files,dbWal:{database:files['game.db'],wal:files['game.db-wal']??{exists:false}},lock:{ino:files['state.lock'].ino,dev:files['state.lock'].dev}};
}
export async function stateReadAcl(root,paths,consumer,record,run=execFileSync,engine=windowsPowerShellExecutable()) {
  const script=await readFile(new URL('./windows-state-read-acl.ps1',import.meta.url),'utf8');
  const request=(action,fields={})=>{
    let output,result;
    try{output=run(engine,['-NoProfile','-NonInteractive','-Command',script],{input:JSON.stringify({action,root,paths,...fields}),encoding:'utf8',timeout:30000});result=JSON.parse(output);}
    catch(error){(record.nativeFailures??=[]).push({action,code:error.code??null,status:error.status??null,signal:error.signal??null,stdout:String(output??error.stdout??''),stderr:String(error.stderr??''),message:error.message});throw error;}
    record[action]=result;assert(result&&Array.isArray(result.errors)&&Array.isArray(result.entries),'Complete native ACL envelope required');assert.equal(result.errors.length,0,`Native ACL ${action}: ${JSON.stringify(result.errors)}`);return result;
  };
  const before=request('capture',{consumer});assert.match(before.sid,/^S-\d+(?:-\d+)+$/);assert.equal(before.consumerSid,before.sid);assert.deepEqual(before.entries.map(entry=>entry.path),paths);
  for(const entry of before.entries)assert(!entry.aces.some(ace=>ace.type==='Deny'&&ace.sid===before.sid),'Fresh state must not already have a deny for this SID');
  return {
    apply(){record.aclApplied=true;const result=request('deny',{sid:before.sid});requireReadDeny(before.entries,result.entries,before.sid);},
    restore(){const result=request('restore',{before:before.entries});requireRestoredAcls(before.entries,result.entries);record.aclRestored=true;}
  };
}
function imageProcesses(program) {
  const script=`$ErrorActionPreference='Stop'; $program=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()); $filter="ExecutablePath = '" + $program.Replace('\\','\\\\').Replace("'","\\'") + "'"; $items=@(Get-CimInstance Win32_Process -Filter $filter | ForEach-Object { @{pid=$_.ProcessId;started=$_.CreationDate.ToUniversalTime().ToString('o');executable=$_.ExecutablePath;argv=$_.CommandLine} }); ConvertTo-Json -InputObject $items -Compress`;
  const items=JSON.parse(execFileSync(windowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-Command',script],{input:JSON.stringify(program),encoding:'utf8',timeout:30000}));assert(Array.isArray(items),'Native image process array required');return items;
}
async function consumerProbe(app,state,probe) {
  return app.evaluate(async(_electron,{state,probe})=>{const fs=process.getBuiltinModule('fs/promises'),result={};for(const [name,action] of [['read',()=>fs.readFile(probe,'utf8')],['list',()=>fs.readdir(state)]])try{result[name]={success:true,value:await action()};}catch(error){result[name]={success:false,code:error.code,errno:error.errno,syscall:error.syscall,path:error.path,message:error.message};}return result;},{state,probe});
}
export async function windowsStateReadDenied({app,page,native,binary,resources,userData,out,env,check,report,requestedAt,wait}) {
  const record=report.windowsStateReadDenied={status:'running',purpose:'Focused native read-permission-denied synthetic state; NOT game/offline/default-browser/all-platform proof',errors:[],cleanupPending:true,intendedDenyMask:1},state=join(userData,'state'),probe=join(state,'read-denial-probe.txt');let acl;
  await stateReadDeniedLifecycle(record,{
    async exercise(){
      assert(win32.isAbsolute(userData)&&userData.toLowerCase().startsWith(out.toLowerCase()+win32.sep),'Only newly owned external userData allowed');
      const pid=await app.evaluate(()=>process.pid);record.launcher=windowsProcessIdentity(pid);assertOwnedWindowsProcess(record.launcher,{program:native,pid,requestedAt,observedAt:Date.now()});assert(record.launcher.argv.includes(userData),'Consumer must own exact fresh profile');
      record.seed={};for(const [name,args] of [['fixture',['--backup-fixture',state,join(resources,'runtime/data')]],['validation',['--backup-load',join(state,'game.db'),join(resources,'runtime/data')]]])record.seed[name]=execFileSync(binary,args,{encoding:'utf8',timeout:30000,env,windowsHide:true});
      const lock=await open(join(state,'state.lock'),'wx');await lock.close();record.lockOrigin='Exclusive-new empty QA lock before first desktop start; never unlinked/truncated/replaced';
      await writeFile(probe,'owned read-denial sentinel',{flag:'wx'});record.before=await stateSnapshot(state);record.beforeProbe=await consumerProbe(app,state,probe);assert.equal(record.beforeProbe.read.value,'owned read-denial sentinel');assert(record.beforeProbe.list.success);
      acl=await stateReadAcl(state,await statePaths(state),record.launcher,record);acl.apply();check('exact consumer SID READ_DATA/LIST_DIRECTORY-only deny inherited by all synthetic state files',true);
      record.deniedProbe=await consumerProbe(app,state,probe);for(const name of ['read','list'])assert(!record.deniedProbe[name].success&&['EACCES','EPERM'].includes(record.deniedProbe[name].code),'Actual consumer OS read/list must fail with EACCES/EPERM');check('same consumer main process actually cannot read/list owned state',true);
      await page.evaluate(()=>{globalThis.qaReadDeniedViews=[];window.launcher.changed(view=>globalThis.qaReadDeniedViews.push({pid:view.pid,status:view.status,listening:view.logs.some(line=>/game frontdoor listening/.test(line))}));});record.childObservations=[];record.startRequestedAt=Date.now();
      const observeChild=pid=>{if(record.childObservations.some(item=>item.pid===pid))return;const identity=imageProcesses(binary).find(item=>item.pid===pid);record.childObservations.push(identity?{pid,found:true,...identity}:{pid,found:false,reason:'Fast child absent at CIM snapshot; no identity invented'});if(identity){assertOwnedWindowsProcess(identity,{program:binary,pid,requestedAt:record.startRequestedAt,observedAt:Date.now()});assert(identity.argv.includes('--desktop')&&identity.argv.includes(join(userData,'desktop-config.json')),'Observed child must use the real desktop config');}};
      await page.getByRole('button',{name:'Start Server',exact:true}).click();
      await wait(async()=>{const view=await page.evaluate(()=>window.launcher.status());if(view.pid)observeChild(view.pid);if(view.status==='ready')throw Error('Read-denied state unexpectedly became ready');return view.status==='stopped'&&view.message.includes('before listening');},'read-permission-denied early child exit',30000);
      record.view=await page.evaluate(()=>window.launcher.status());record.views=await page.evaluate(()=>globalThis.qaReadDeniedViews);for(const pid of new Set(record.views.map(view=>view.pid).filter(Boolean)))observeChild(pid);
      record.ui={message:await page.locator('#message').innerText(),logs:await page.locator('#logs').innerText()};assert(record.ui.message.includes('code=1')&&/os error 5/.test(record.ui.logs),'Actual UI panels must display the native permission failure');
      const processes=imageProcesses(binary);
      assert(!record.view.pid&&record.view.message.includes('code=1'));assert(!record.views.some(view=>view.status==='ready'||view.listening));assert(!record.view.message.includes('Durable shutdown verified'),'Startup rejection must not claim a successful save');assert(record.view.logs.some(line=>/os error 5/.test(line)),'Actual native access-denied error must surface');assert(record.view.logs.some(line=>line.includes('open state lock')&&line.includes('state.lock')),'Native permission error must identify the owned state lock operation');assert(!record.view.logs.some(line=>/game frontdoor listening/.test(line)));assert(await page.getByRole('button',{name:'Start Client',exact:true}).isDisabled());assert.equal(processes.length,0,'No owned server may remain after failed startup');
      const screenshot=join(out,'state-read-denied.png');await page.screenshot({path:screenshot});report.screenshots.push(screenshot);check('actual packaged Start reports permission exit1 before listening with no Ready/client/orphan',true);
    },
    async drain(){const view=await page.evaluate(()=>window.launcher.status());record.beforeCleanupView=view;if(record.startRequestedAt)record.views=await page.evaluate(()=>globalThis.qaReadDeniedViews);if(view.pid)await page.evaluate(()=>window.launcher.stop());},
    async restore(){if(acl)acl.restore();},
    async serverExit(){record.beforeSnapshotProcesses=imageProcesses(binary);record.serverExitedBeforeSnapshot=record.beforeSnapshotProcesses.length===0;assert(record.serverExitedBeforeSnapshot,'Live owned server: final state snapshot is not verified');},
    async probeRestored(){if(!record.before)return;record.restoredProbe=await consumerProbe(app,state,probe);assert.equal(record.restoredProbe.read.value,'owned read-denial sentinel');assert(record.restoredProbe.list.success);check('owned state read/list access is restored for the same consumer',true);},
    async stateUnchanged(){if(!record.before)return;record.after=await stateSnapshot(state);assert(record.serverExitedBeforeSnapshot,'State snapshot is partial without server exit proof');assert.deepEqual(record.after,record.before,'DB/WAL/all state bytes and lock inode/dev must remain unchanged');check('restored synthetic DB/WAL bytes and original state.lock inode/dev are exact',true);},
    async close(){const controller=app.process();await app.close();record.launcherClosedNormally=true;record.launcherExitCode=controller.exitCode;assert.equal(controller.exitCode,0,'Expected startup rejection must allow normal launcher exit0, not a fabricated child save result');},
    async imagesExited(){record.finalImages=[];const errors=[];for(const program of [binary,native])try{const processes=imageProcesses(program);record.finalImages.push({program,processes});assert.equal(processes.length,0,'Owned image remains live; never force-killed');}catch(error){errors.push(error);}record.imagesExited=errors.length===0;if(errors.length)throw new AggregateError(errors,'Owned image exit unverified');}
  });
}
