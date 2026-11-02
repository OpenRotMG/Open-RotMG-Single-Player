import test from 'node:test';
import assert from 'node:assert/strict';
import {verifySafariProcess,verifySafariEndpoint,cleanupSafariCli,SAFARI_SERVICE_REQUIREMENT} from '../scripts/safari-driver-ownership.mjs';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';

const root={pid:1306,ppid:1282,uid:501,started:'root-start',argv:'/usr/bin/safaridriver --port 49167'};
const service={pid:1372,ppid:1,uid:501,started:'service-start',argv:'OS-managed service',executable:'/System/Volumes/Preboot/Cryptexes/App/System/Library/StagedFrameworks/Safari/WebDriver.framework/Versions/A/XPCServices/com.apple.WebDriver.HTTPService.xpc/Contents/MacOS/com.apple.WebDriver.HTTPService',signature:{requirement:SAFARI_SERVICE_REQUIREMENT,status:0}};
test('safari-driver-ownership validates an OS-managed Apple service without claiming descendant ownership',()=>{
  assert.equal(SAFARI_SERVICE_REQUIREMENT,'=anchor apple and identifier "com.apple.WebDriver.HTTPService"','codesign -R must receive inline source, not a requirement filename');
  verifySafariEndpoint(root,{...root},service,501);
});
test('safari-driver-ownership rejects foreign user, non-Apple signature and unexpected service executable',()=>{
  assert.throws(()=>verifySafariEndpoint(root,root,{...service,uid:502},501),/current user/);
  assert.throws(()=>verifySafariEndpoint(root,root,{...service,signature:{requirement:SAFARI_SERVICE_REQUIREMENT,status:1}},501),/signature/);
  assert.throws(()=>verifySafariEndpoint(root,root,{...service,executable:'/untrusted/com.apple.WebDriver.HTTPService'},501),/Unexpected installed/);
});
test('safari-driver-ownership rejects CLI PID reuse or changed argv before control or signals',()=>{
  assert.throws(()=>verifySafariProcess(root,{...root,started:'reused-pid'}),/started changed/);
  assert.throws(()=>verifySafariEndpoint(root,{...root,argv:'unrelated'},service,501),/argv changed/);
});
test('safari-driver-ownership cleanup signals only our CLI, never the OS service',async()=>{
  const report={errors:[]},signals=[];let live=true;
  await cleanupSafariCli(report,root,{alive:()=>live,identity:async()=>root,signal:(pid,signal)=>{signals.push({pid,signal});live=false;},waitForExit:async()=>{}});
  assert.deepEqual(signals,[{pid:root.pid,signal:'SIGTERM'}]);assert.deepEqual(report.errors,[]);
});
test('safari-driver-ownership EPERM preserves primary failure before failed receipt, without unverified signal',async()=>{
  const report={status:'error',errors:['primary endpoint failure']},signals=[];
  await cleanupSafariCli(report,root,{alive:()=>{throw Object.assign(new Error('EPERM liveness unknown'),{code:'EPERM'});},identity:async()=>root,signal:(...args)=>signals.push(args),waitForExit:async()=>{}});
  assert.deepEqual(signals,[]);assert.equal(report.errors[0],'primary endpoint failure');assert(report.errors[1].includes('EPERM'));assert.equal(report.status,'error');
  await mkdir('.qa/unit',{recursive:true});const out=await mkdtemp(resolve('.qa/unit/safari-cleanup-'));
  try{const file=join(out,'result.json');await writeFile(file,JSON.stringify(report));const saved=JSON.parse(await readFile(file));assert.equal(saved.status,'error');assert.equal(saved.errors.length,2);}
  finally{await rm(out,{recursive:true});}
});
