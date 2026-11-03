import test from 'node:test';
import assert from 'node:assert/strict';
import {closeWindowsEdge} from '../scripts/windows-edge-cleanup.mjs';

const identity={pid:123,started:'actual-start',argv:'msedge --user-data-dir=owned-profile',executable:'msedge.exe'};
const state=()=>({context:{close:async()=>{}},protocol:{send:async method=>assert.equal(method,'Browser.close')},identity,profile:'owned-profile',record:{}});
test('windows-edge-cleanup observes normal exit before framework disposal',async()=>{
  const s=state(),calls=[];s.context.close=async()=>calls.push('dispose');
  await closeWindowsEdge(s,{waitForExit:async pid=>{assert.equal(pid,123);calls.push('exit');return true;},identity:()=>assert.fail('identity reread unnecessary'),signal:()=>assert.fail('normal exit must not signal')});
  assert.deepEqual(calls,['exit','dispose']);assert.equal(s.record.browserExited,true);
});
test('windows-edge-cleanup refuses changed/reused PID and never signals an unknown process',async()=>{
  const s=state();let signals=0,disposed=0;s.context.close=async()=>disposed++;
  await assert.rejects(closeWindowsEdge(s,{waitForExit:async()=>false,identity:()=>({...identity,started:'different-start'}),signal:()=>signals++}),/Immediate owned Edge identity required/);
  assert.equal(signals,0);assert.equal(disposed,0);assert.equal(s.record.browserExited,undefined);
});
test('windows-edge-cleanup never signals a copied-image redirect into installed Edge',async()=>{
  const s=state();s.expectedExecutable='owned-copy/msedge.exe';let signals=0;
  await assert.rejects(closeWindowsEdge(s,{waitForExit:async()=>false,identity:()=>({...identity}),signal:()=>signals++}),/Never signal a redirected installed Edge image/);assert.equal(signals,0);
});
test('windows-edge-cleanup retains protocol failure even when exit is later observed',async()=>{
  const s=state();s.protocol.send=async()=>{throw Error('original protocol error');};
  await assert.rejects(closeWindowsEdge(s,{waitForExit:async()=>true}),/original protocol error/);assert.equal(s.record.browserExited,true);
});
test('windows-edge-cleanup permits only verified normal signal and never erases the initial cleanup failure',async()=>{
  const s=state(),signals=[];let waits=0;
  await assert.rejects(closeWindowsEdge(s,{waitForExit:async()=>++waits>1,identity:()=>({...identity}),signal:(pid,signal)=>signals.push({pid,signal})}),/did not exit after protocol close/);
  assert.deepEqual(signals,[{pid:123,signal:'SIGTERM'}]);assert.equal(s.record.browserExited,true);
});
test('windows-edge-cleanup awaits only fresh pre-identity framework cleanup and marks exit unverified',async()=>{
  const s=state();s.identity=undefined;let closed=false;s.context.close=async()=>{closed=true;};
  await assert.rejects(closeWindowsEdge(s,{signal:()=>assert.fail('unknown PID must never be signaled')}),/exit unverified/);
  assert(closed);assert.equal(s.record.browserExitVerification,'unverified');
});
