import test from 'node:test';
import assert from 'node:assert/strict';
import {verifySafariProcess,verifySafariListener,cleanupSafariDrivers} from '../scripts/safari-driver-ownership.mjs';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';

const root={pid:3133,ppid:3000,started:'root-start',argv:'/usr/bin/safaridriver --port 43123'};
const child={pid:3139,ppid:3133,started:'child-start',argv:'/actual/Safari.app/Contents/MacOS/safaridriver --port 43123'};
test('safari-driver-ownership accepts the spawned driver or a proved wrapper descendant',()=>{
  verifySafariListener(root,{...root},[{...root}]);
  verifySafariListener(root,{...root},[{...child},{...root}]);
});
test('safari-driver-ownership rejects a foreign listener even when its argv has the same port',()=>{
  const foreign={...child,ppid:1},launchd={pid:1,ppid:0,started:'system-start',argv:'/sbin/launchd'};
  assert.throws(()=>verifySafariListener(root,root,[foreign,launchd]),/ownership is not verified/);
  assert.throws(()=>verifySafariListener(root,root,[foreign,root]),/ancestry is disconnected/);
});
test('safari-driver-ownership rejects PID reuse or changed argv before cleanup signals',()=>{
  assert.throws(()=>verifySafariProcess(child,{...child,started:'reused-pid-start'}),/started changed/);
  assert.throws(()=>verifySafariProcess(child,{...child,argv:'unrelated process'}),/argv changed/);
  assert.throws(()=>verifySafariListener(root,{...root,started:'reused-root'},[child,root]),/started changed/);
});
test('safari-driver-ownership rejects cyclic or incomplete observed ancestry',()=>{
  assert.throws(()=>verifySafariListener(root,root,[child,child,root]),/must not cycle/);
  assert.throws(()=>verifySafariListener(root,root,[{...child,started:''},root]),/Complete observed process identity/);
});
test('safari-driver-ownership EPERM preserves primary failure and other cleanup before writing failed receipt',async()=>{
  const report={status:'error',errors:['primary ownership failure']},signals=[];let rootAlive=true;
  await cleanupSafariDrivers(report,[child,root],{
    alive:pid=>{if(pid===child.pid)throw Object.assign(new Error('EPERM liveness unknown'),{code:'EPERM'});return rootAlive;},
    identity:async()=>({...root}),signal:(pid,signal)=>{signals.push({pid,signal});rootAlive=false;},waitForExit:async()=>{},
  });
  assert.deepEqual(signals,[{pid:root.pid,signal:'SIGTERM'}]);assert.equal(report.status,'error');
  assert.equal(report.errors[0],'primary ownership failure');assert(report.errors.some(error=>error.includes('EPERM')));
  assert(!('listenerExited' in report),'Unknown liveness must not become gone');
  await mkdir('.qa/unit',{recursive:true});const out=await mkdtemp(resolve('.qa/unit/safari-cleanup-'));
  try{const file=join(out,'result.json');await writeFile(file,JSON.stringify(report));const saved=JSON.parse(await readFile(file));assert.equal(saved.status,'error');assert.equal(saved.errors.length,2);}
  finally{await rm(out,{recursive:true});}
});
