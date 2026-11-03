import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,cp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {cleanupWindowsFirewallRules,cleanupWindowsOwnedRules,windowsOfflineCanaryResult,verifyWindowsOfflineCanary} from '../scripts/windows-firewall-cleanup.mjs';
import {tree} from '../scripts/assets.mjs';

test('windows offline rejects signaled or timed-out canaries even with valid passed output',()=>{
  const stdout=JSON.stringify({status:'passed',executable:'owned-node.exe'});
  for(const message of ['signal termination','timeout']){
    const error=Object.assign(new Error(message),{code:null,signal:'SIGTERM'}),result=windowsOfflineCanaryResult(error,stdout,'native stderr');
    assert.equal(result.exitCode,null);assert.equal(result.signal,'SIGTERM');assert.throws(()=>verifyWindowsOfflineCanary(result,'owned-node.exe'),/execution failed/);
  }
  assert.equal(verifyWindowsOfflineCanary(windowsOfflineCanaryResult(null,stdout,''),'owned-node.exe').status,'passed');
});

test('windows-firewall-cleanup attempts every exact name despite observation and first-removal errors',async()=>{
  const report={errors:['primary failure']},calls=[];let observations=0;
  await cleanupWindowsFirewallRules(report,['owned-a','owned-b'],{
    observe:async()=>{calls.push('observe');if(observations++===0)throw Error('observation denied');return [];},
    remove:async name=>{calls.push(name);if(name==='owned-a')throw Error('first removal denied');return {name,removed:true};},
  });
  assert.deepEqual(calls,['observe','owned-a','owned-b','observe']);assert.equal(report.errors.length,3);assert.equal(report.errors[0],'primary failure');assert.equal(report.status,'failed');
});
test('windows-firewall-cleanup accepts only the exact native expected-absence classification',async()=>{
  const report={errors:[]};
  await cleanupWindowsFirewallRules(report,['owned-a','owned-b'],{observe:async()=>[],remove:async name=>({name,removed:false,category:'ObjectNotFound',errorId:name==='owned-a'?'CmdletizationQuery_NotFound_InstanceID,Remove-NetFirewallRule':'AccessDenied,Remove-NetFirewallRule'})});
  assert.equal(report.errors.length,1);assert(report.errors[0].includes('owned-b'));assert.equal(report.ruleRemovalOutcomes.length,2);assert.equal(report.status,'failed');
});
test('windows owned rules retain only live or exit-unverified images and remove every proven-exited rule',async()=>{
  const plans=['node','edge','launcher','server'].map(role=>({name:'owned-'+role,program:role+'.exe'})),rules=new Map(plans.map(plan=>[plan.name,{...plan}])),removed=[],report={errors:['primary failure']};
  await cleanupWindowsOwnedRules(report,plans,{processes:async program=>{if(program==='server.exe')throw Error('CIM inspection denied');return program==='edge.exe'?[{pid:41,started:'2026-11-03T00:00:00Z',executable:program,argv:'--type=renderer'}]:[];},observe:async names=>names.filter(name=>rules.has(name)).map(name=>rules.get(name)),remove:async name=>{removed.push(name);rules.delete(name);return {name,removed:true};}});
  assert.deepEqual(removed,['owned-node','owned-launcher']);assert.equal(report.status,'failed');assert.equal(report.cleanupPending,true);assert.deepEqual(report.retainedRules.map(rule=>rule.name),['owned-edge','owned-server']);assert.equal(report.retainedRules[0].processes[0].argv,'--type=renderer');assert.match(report.retainedRules[1].inspectionError,/CIM inspection denied/);assert(report.retainedRules.every(rule=>/disposable VM teardown/.test(rule.reason)));assert.deepEqual(report.rulesAfterCleanup.map(rule=>rule.name),['owned-edge','owned-server']);assert.equal(report.errors[0],'primary failure');
});
test('windows owned rules successful path proves every image exited and removes every registered rule',async()=>{
  const plans=[{name:'owned-a',program:'a.exe'},{name:'owned-b',program:'b.exe'}],active=new Set(plans.map(plan=>plan.name)),report={errors:[]};
  await cleanupWindowsOwnedRules(report,plans,{processes:async()=>[],observe:async names=>names.filter(name=>active.has(name)).map(name=>({name})),remove:async name=>{active.delete(name);return {name,removed:true};}});assert.deepEqual(report.errors,[]);assert.equal(report.cleanupPending,false);assert.deepEqual(report.retainedRules,[]);assert.deepEqual(report.rulesAfterCleanup,[]);assert.equal(report.programExitObservations.length,2);
});
test('windows owned rule removal or final-observation IO failure stays failed and cleanup pending',async()=>{
  for(const observeFailure of [false,true]){const report={errors:[]},plans=[{name:'owned-a',program:'a.exe'},{name:'owned-b',program:'b.exe'}],active=new Set(plans.map(plan=>plan.name)),removed=[];await cleanupWindowsOwnedRules(report,plans,{processes:async()=>[],observe:async names=>{if(observeFailure)throw Error('final inspection IO error');return names.filter(name=>active.has(name)).map(name=>({name}));},remove:async name=>{removed.push(name);if(!observeFailure&&name==='owned-a')throw Error('remove denied');active.delete(name);return {name,removed:true};}});assert.deepEqual(removed,['owned-a','owned-b']);assert.equal(report.status,'failed');assert.equal(report.cleanupPending,true);assert(report.errors.length>0);}
});
test('windows offline complete Chromium inventory detects altered non-executable resources',async()=>{
  await mkdir('.qa/unit',{recursive:true});const root=await mkdtemp(resolve('.qa/unit/chrome-inventory-'));
  try{
    const source=join(root,'source'),copy=join(root,'copy');await mkdir(join(source,'resources'),{recursive:true});await writeFile(join(source,'chrome.exe'),'executable');await writeFile(join(source,'resources/data.pak'),'resource');
    await cp(source,copy,{recursive:true});const before=await tree(source,['']);assert.deepEqual(await tree(copy,['']),before);
    await writeFile(join(copy,'resources/data.pak'),'changed');const after=await tree(copy,['']);assert.equal(after.files['chrome.exe'],before.files['chrome.exe']);assert.notEqual(after.sha256,before.sha256);assert.notDeepEqual(after.files,before.files);
  }finally{await rm(root,{recursive:true});}
});
