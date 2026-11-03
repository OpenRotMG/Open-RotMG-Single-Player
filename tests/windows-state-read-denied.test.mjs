import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {windowsStateReadDeniedMode,requireReadDeny,requireRestoredAcls,stateReadDeniedLifecycle,stateReadAcl} from '../scripts/windows-state-read-denied.mjs';

const sid='S-1-5-21-1-2-3-1001',root='D:\\owned\\state',paths=[root,root+'\\game.db',root+'\\state.lock'];
const before=paths.map((path,i)=>({path,directory:i===0,sddl:'original-'+i,aces:[]}));
const denied=before.map((entry,i)=>({...entry,sddl:'denied-'+i,aces:[{sid,type:'Deny',mask:1,inherited:i!==0,inheritance:i===0?3:0,propagation:0}]}));
test('windows-state-read-denied explicit native focused mode rejects incompatible cases without changing old modes',()=>{
  assert.equal(windowsStateReadDeniedMode([],'linux','x64',undefined,undefined,[]),false);
  assert.equal(windowsStateReadDeniedMode(['--windows-state-read-denied'],'win32','x64','true',undefined,[]),true);
  for(const tuple of [['linux','x64','true',undefined,[]],['win32','arm64','true',undefined,[]],['win32','x64','false',undefined,[]],['win32','x64','true','ci-edge',[]],['win32','x64','true',undefined,['--no-sandbox']]])assert.throws(()=>windowsStateReadDeniedMode(['--windows-state-read-denied'],...tuple));
  for(const extra of ['--failure-tests-only','--windows-offline','--check-port-only','--unknown'])assert.throws(()=>windowsStateReadDeniedMode(['--windows-state-read-denied',extra],'win32','x64','true',undefined,[]));
});
test('windows-state-read-denied validates only exact mask1 and complete inheritance/readback, never extra Synchronize or read-control/traverse',()=>{
  requireReadDeny(before,denied,sid);requireRestoredAcls(before,structuredClone(before));
  for(const patch of [{mask:0x100001},{mask:0x20001},{mask:0x21},{mask:0},{inherited:true},{inheritance:0},{propagation:1}]){const rows=structuredClone(denied);Object.assign(rows[0].aces[0],patch);assert.throws(()=>requireReadDeny(before,rows,sid));}
  assert.throws(()=>requireReadDeny(before,denied.slice(1),sid));const duplicate=structuredClone(denied);duplicate[1].aces.push({...duplicate[1].aces[0]});assert.throws(()=>requireReadDeny(before,duplicate,sid));
  assert.throws(()=>requireRestoredAcls(before,denied));
});
test('windows-state-read-denied native ACL controller registers capture before mutation and preserves failed apply/restore envelopes',async()=>{
  const calls=[],record={},consumer={pid:42,started:'2026-11-03T06:00:00.0000000Z'};
  const run=(file,args,options)=>{const request=JSON.parse(options.input);calls.push(request.action);assert.equal(request.root,root);assert.deepEqual(request.paths,paths);return JSON.stringify(request.action==='capture'?{sid,consumerSid:sid,entries:before,errors:[]}:request.action==='deny'?{entries:denied,errors:[{stage:'readback',path:paths[1],message:'actual inspection error'}]}:{entries:before,errors:[]});};
  const acl=await stateReadAcl(root,paths,consumer,record,run,'/native/pwsh.exe');assert.deepEqual(calls,['capture']);assert.throws(()=>acl.apply(),/actual inspection error/);assert.equal(record.aclApplied,true);assert.equal(record.deny.errors[0].path,paths[1]);acl.restore();assert.equal(record.aclRestored,true);assert.deepEqual(calls,['capture','deny','restore']);
  const failed={},badRestore=await stateReadAcl(root,paths,consumer,failed,(file,args,options)=>{const action=JSON.parse(options.input).action;return JSON.stringify(action==='capture'?{sid,consumerSid:sid,entries:before,errors:[]}:action==='deny'?{entries:denied,errors:[]}:{entries:before,errors:[{stage:'restore',path:paths[1],message:'actual ACL IO failure'}]});},'/native/pwsh.exe');
  badRestore.apply();assert.throws(()=>badRestore.restore(),/actual ACL IO failure/);assert.equal(failed.aclApplied,true);assert.notEqual(failed.aclRestored,true);assert.equal(failed.restore.errors[0].path,paths[1]);
});
test('windows-state-read-denied native transport failure retains partial output/null status and still permits owned restore',async()=>{
  const record={},error=Object.assign(Error('native denied transport'),{code:'EPERM',status:null,signal:'SIGTERM',stdout:'partial ACL evidence',stderr:'native diagnostic'});
  const acl=await stateReadAcl(root,paths,{pid:42},record,(file,args,options)=>{const action=JSON.parse(options.input).action;if(action==='deny')throw error;return JSON.stringify(action==='capture'?{sid,consumerSid:sid,entries:before,errors:[]}:{entries:before,errors:[]});},'/native/pwsh.exe');
  assert.throws(()=>acl.apply(),cause=>cause===error);assert.equal(record.nativeFailures[0].stdout,'partial ACL evidence');assert.equal(record.nativeFailures[0].status,null);assert.equal(record.nativeFailures[0].signal,'SIGTERM');acl.restore();assert.equal(record.aclRestored,true);
});
test('windows-state-read-denied cleanup attempts drain, ACL, probes, snapshot, Close and both image checks despite primary/liveness/restore/IO errors',async()=>{
  const record={errors:[],aclApplied:true},calls=[];
  const operations={exercise:async()=>{calls.push('exercise');throw Error('primary actual OS failure');}};
  for(const stage of ['drain','restore','serverExit','probeRestored','stateUnchanged','close','imagesExited'])operations[stage]=async()=>{calls.push(stage);throw Object.assign(Error(stage+' actual fault'),{code:stage==='serverExit'?'EPERM':'EIO'});};
  await assert.rejects(stateReadDeniedLifecycle(record,operations),AggregateError);assert.deepEqual(calls,['exercise','drain','restore','serverExit','probeRestored','stateUnchanged','close','imagesExited']);assert.match(record.errors[0].message,/primary actual OS failure/);assert(record.errors.some(item=>item.stage==='restore'));assert(record.errors.some(item=>item.stage==='stateUnchanged'));assert.equal(record.cleanupPending,true);assert.equal(record.status,'failed');
});
test('windows-state-read-denied expected startup rejection is a passing case only after full ACL/image cleanup',async()=>{
  const record={errors:[],aclApplied:true},calls=[];const operations={};for(const stage of ['exercise','drain','restore','serverExit','probeRestored','stateUnchanged','close','imagesExited'])operations[stage]=async()=>{calls.push(stage);if(stage==='restore')record.aclRestored=true;if(stage==='imagesExited')record.imagesExited=true;};
  await stateReadDeniedLifecycle(record,operations);assert.equal(record.status,'passed');assert.equal(record.cleanupPending,false);assert.equal(calls.at(-1),'imagesExited');
  const unknown={errors:[],aclApplied:true};await assert.rejects(stateReadDeniedLifecycle(unknown,operations),/cleanup failed/);assert.equal(unknown.status,'failed');assert.equal(unknown.cleanupPending,true);
});
for(const [name,eol] of [['LF','\n'],['CRLF','\r\n']])test(`windows-state-read-denied source wiring and native ACL restore stages (${name})`,async()=>{
  const source=(await readFile('scripts/package-test.mjs','utf8')).replace(/\r\n/g,'\n').replace(/\n/g,eol);assert.equal(source.includes('\r\n'),name==='CRLF');const normalized=source.replace(/\r\n/g,'\n');
  assert(normalized.indexOf('report.windowsFocusedBinding=await bindWindowsBuild()')<normalized.indexOf('const permissionLaunchAt='));
  assert(normalized.indexOf('restoreInstallation=await protectInstallation')<normalized.indexOf('const permissionLaunchAt='));
  const branch=normalized.slice(normalized.indexOf('    if(stateReadDenied){'),normalized.indexOf('    if(!failureTestsOnly) {',normalized.indexOf('    if(stateReadDenied){')));
  assert.match(branch,/await windowsStateReadDenied\(/);assert(!/nativeGame|failureCloseTests|await start\(/.test(branch));assert.match(normalized,/windowsStateReadDenied\?\.cleanupPending===true/);
  const ps=(await readFile('scripts/windows-state-read-acl.ps1','utf8')).replace(/\r\n/g,'\n').replace(/\n/g,eol).replace(/\r\n/g,'\n');assert.match(ps,/FileSystemRights\]1,/);assert.match(ps,/GetOwnerSid/);assert.match(ps,/consumer\.started/);assert.match(ps,/foreach\(\$entry in \$request.before\)[\s\S]*try[\s\S]*SetSecurityDescriptorSddlForm\(\$entry.sddl\)[\s\S]*catch/);assert.match(ps,/finally \{[\s\S]*foreach\(\$path in \$request.paths\)/);assert(!/icacls|Remove-Item|takeown|Synchronize|ReadAndExecute/.test(ps));
});
test('windows-state-read-denied fixed manual workflow binds paired native package and no game/browser/offline replay',async()=>{
  const workflow=await readFile('.github/workflows/windows-state-read-denied.yml','utf8');assert.match(workflow,/runs-on: windows-2022/);assert.match(workflow,/workflow_dispatch:/);assert.match(workflow,/PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1'/);assert.match(workflow,/if: always\(\)/);
  let previous=-1;for(const command of ['node scripts/ci-inputs.mjs','npm test && npm run package','node scripts/package-test.mjs --windows-state-read-denied']){const index=workflow.indexOf(command);assert(index>previous);previous=index;}
  assert(!/inputs:|matrix:|playwright install|BROWSER_MODE|--windows-offline|--failure-tests-only|self-hosted|macos|native-game|offline-probe/.test(workflow));
});
