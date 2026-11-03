import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {join} from 'node:path';

test('package-test server exit inspection EPERM retains the primary error and still runs policy, ACL, lease and final persistence',async()=>{
  const source=await readFile('scripts/package-test.mjs','utf8'),marker='  finally {',start=source.lastIndexOf(marker),end=source.indexOf('\n  }\n}\nfunction alive',start);assert(start>0&&end>start);
  const calls=[],report={errors:['original journey failure'],windowsOffline:{errors:[],cleanupPending:false}},process={exitCode:0};
  await runInNewContext(`(async()=>{${source.slice(start+marker.length,end)}})()`,{
    report,process,serverPid:42,alive:()=>{throw Object.assign(Error('actual EPERM inspection'),{code:'EPERM'});},browserCleanup:undefined,launcher:undefined,display:undefined,
    offlinePolicy:{finish:async()=>calls.push('policy')},restoreInstallation:async()=>calls.push('ACL'),lease:{release:async()=>calls.push('lease')},persist:async()=>{calls.push('persist');assert.equal(report.status,'failed');assert.equal(process.exitCode,1);assert.equal(report.errors[0],'original journey failure');assert(report.errors.some(error=>error.includes('actual EPERM inspection')));},
    console:{log:()=>{},error:()=>{}},join,out:'owned-result'
  });
  assert.deepEqual(calls,['policy','ACL','lease','persist']);assert.equal(process.exitCode,1);assert.equal(report.status,'failed');
});
