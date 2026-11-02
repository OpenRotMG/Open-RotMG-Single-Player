import test from 'node:test';
import assert from 'node:assert/strict';
import {closePrePidOfflineContext,persistMacOfflineEvidence,macOfflinePayloadCommands} from '../scripts/macos-offline-evidence.mjs';

test('macos-offline-evidence confines both payload commands under one exact policy without changing normal graphics',()=>{
  const commands=macOfflinePayloadCommands('/owned/offline.sb','/node','/canary.mjs','/chromium','/fresh/profile');
  assert.deepEqual(commands.node,['/usr/bin/sandbox-exec','-f','/owned/offline.sb','/node','/canary.mjs','/owned/offline.sb']);
  assert.deepEqual(commands.browser.slice(0,4),['/usr/bin/sandbox-exec','-f','/owned/offline.sb','/chromium']);
  assert(commands.browser.includes('--remote-debugging-pipe'));assert(!commands.browser.some(arg=>/--no-sandbox|--use-angle|--ignore-gpu-blocklist|--disable-web-security/.test(arg)));
});

test('macos-offline-evidence closes a freshly created pre-PID context without claiming verified OS exit',async()=>{
  let closed=false;const report={status:'failed',errors:['CDP discovery failed']};
  await closePrePidOfflineContext({close:async()=>{closed=true;}},report);
  assert(closed);assert.equal(report.browserExitVerification,'unverified');assert.equal(report.prePidFrameworkClose.completed,true);assert.equal(report.status,'failed');assert.deepEqual(report.errors,['CDP discovery failed']);
});
test('macos-offline-evidence preserves primary and pre-PID cleanup errors',async()=>{
  const report={status:'failed',errors:['CDP discovery failed']};
  await closePrePidOfflineContext({close:async()=>{throw Error('owned framework close failed');}},report);
  assert.equal(report.prePidFrameworkClose.completed,false);assert.equal(report.errors[0],'CDP discovery failed');assert(report.errors[1].includes('owned framework close failed'));assert.equal(report.browserExitVerification,'unverified');
});
test('macos-offline-evidence prints primary and cleanup evidence before writing and retains real write failure',async()=>{
  const report={status:'failed',errors:['primary failure','cleanup failure']},events=[];
  const persisted=await persistMacOfflineEvidence(report,'owned/result.json',async()=>{events.push('write');throw Object.assign(Error('ENOSPC receipt'),{code:'ENOSPC'});},text=>events.push(JSON.parse(text)));
  assert.equal(persisted,false);assert.deepEqual(events[0].errors,['primary failure','cleanup failure']);assert.equal(events[1],'write');assert.equal(events[2].errors.length,3);assert(events[2].errors[2].includes('ENOSPC'));assert.equal(report.status,'failed');
});
