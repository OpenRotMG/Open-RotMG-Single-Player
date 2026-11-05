import test from 'node:test';
import assert from 'node:assert/strict';
import fs,{readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Runtime} from '../dist/runtime.js';
import {RuntimeUpdates} from '../dist/updates.js';
import {RuntimeStore,durableRecord,select} from '../dist/update-store.js';
import {RecoveredRuntimeFence} from '../dist/update-recovery.js';
import {digest} from '../dist/update-format.js';
import {backupPath} from '../dist/update-journal.js';
import {recovered} from './update-recovery-fixture.mjs';

// Synthetic records test crash fencing/validation only. They are not Rust, migration or packaged-game evidence.

const completion=f=>({command:'snapshot',binary:join(f.store.root(f.a.id),'openrotmg'),code:0,outcome:'success',ack:{snapshot:backupPath(f.store,'unit-complete.sqlite'),verified:true}});
test('update-recovery exact restore proof permits clean cold reopen, not a generic marker ignore',async()=>{
 const f=await recovered(),cold=new RecoveredRuntimeFence(new RuntimeStore(f.user,f.policy));assert.equal((await cold.requireClean(select(f.a))).sha256,f.sha);
 assert.deepEqual(await readFile(join(f.user,'shutdown-failed.json')),f.marker);
 await assert.rejects(cold.requireClean(select(f.b)),/unknown/);
});
test('update-recovery requires active durable fence before authority and supports repeated strict clean reuse',async()=>{
 const f=await recovered();let previous;
 for(let i=0;i<2;i++){
  const activity=await f.fence.active('authority',select(f.a),null);assert.notEqual(activity.id,previous);previous=activity.id;
  await assert.rejects(new RecoveredRuntimeFence(f.store).requireClean(select(f.a)),/unknown/);
  await f.fence.authorityFinished(activity,completion(f));assert.equal((await f.fence.requireClean(select(f.a))).sha256,f.sha);
 }
});
test('update-recovery active write ENOSPC prevents invoking the operation; no reserve floor',async t=>{
 const f=await recovered(),rename=fs.rename;let invoked=0;const mock=t.mock.method(fs,'rename',async(from,to)=>{if(to===join(f.user,'runtime-activity.json'))throw Object.assign(Error('injected actual write ENOSPC'),{code:'ENOSPC'});return rename(from,to);});
 await assert.rejects((async()=>{await f.fence.active('authority',select(f.a),null);invoked++;})(),/ENOSPC/);assert.equal(invoked,0);mock.mock.restore();await f.fence.requireClean(select(f.a));
});
test('update-recovery cut after active/before child remains blocked on cold reopen',async()=>{
 const f=await recovered();await f.fence.active('authority',select(f.a),null);const cold=new RecoveredRuntimeFence(f.store);await assert.rejects(cold.requireClean(select(f.a)),/unknown/);assert.equal((await cold.activity()).state,'active');
});
test('update-recovery clean write failure retains real success acknowledgement and blocks old receipt',async t=>{
 const f=await recovered(),activity=await f.fence.active('authority',select(f.a),null),rename=fs.rename;
 const mock=t.mock.method(fs,'rename',async(from,to)=>{if(to===join(f.user,'runtime-activity.json'))throw Object.assign(Error('injected clean write ENOSPC'),{code:'ENOSPC'});return rename(from,to);});
 await assert.rejects(f.fence.authorityFinished(activity,completion(f)),e=>e.kind==='recovery'&&e.message.includes('actual close 0/success')&&e.message.includes('acknowledgement=')&&e.message.includes('ENOSPC'));mock.mock.restore();await assert.rejects(new RecoveredRuntimeFence(f.store).requireClean(select(f.a)),/unknown/);
});
test('update-recovery NEW failure retires old chain, archives exact old bytes and blocks cold restart',async()=>{
 const f=await recovered();await f.fence.active('authority',select(f.a),null);
 const runtime=new Runtime(f.store.root(f.a.id),f.user),updates=new RuntimeUpdates(runtime,f.policy,async()=>false);runtime.blockAmbiguousSave(Error('second independent unknown operation'));await runtime.verifyFailureGate();
 const marker=await readFile(join(f.user,'shutdown-failed.json'));assert.notEqual(digest(marker),f.receipt.markerSha256);assert.deepEqual(await readFile(join(f.user,'diagnostics/failure-history',f.receipt.markerSha256+'.json')),f.marker);
 const cold=new RecoveredRuntimeFence(f.store);assert.equal(await cold.authorization(),undefined);await assert.rejects(cold.requireClean(select(f.a)),/without a valid authorization/);assert.equal((await cold.pointer()).state,'retired');
 const next=new Runtime(f.store.root(f.a.id),f.user);new RuntimeUpdates(next,f.policy,async()=>false);await assert.rejects(next.start(),/Previous server shutdown|recovery|authorization/);
});
test('update-recovery changed predecessor, marker and foreign selected identity cannot authorize',async()=>{
 const f=await recovered(),path=join(f.user,'runtime-recovery-history',f.sha+'.json');await writeFile(path,Buffer.concat([await readFile(path),Buffer.from(' ')]));await assert.rejects(f.fence.requireClean(select(f.a)),/digest mismatch/);
 const other=await recovered();await writeFile(join(other.user,'shutdown-failed.json'),'different current marker');await assert.rejects(other.fence.requireClean(select(other.a)),/does not match/);
 const foreign=await recovered(),activity=await foreign.fence.activity();await durableRecord(join(foreign.user,'runtime-activity.json'),{...activity,selected:select(foreign.b)});await assert.rejects(foreign.fence.requireClean(select(foreign.a)),/unknown/);
});
test('update-recovery healthy authenticated transition stays ACTIVE until actual clean server close',async()=>{
 const f=await recovered(),auth=await f.fence.requireClean(select(f.a)),id=randomUUID();
 const activity=await f.fence.active('server',select(f.b),id,auth),readiness={pid:123,healthProcess:123,listenerSeen:true,binarySha256:f.b.binarySha256,selected:select(f.b)},p={...f.p,id,phase:'ready',readiness,failureSha256:null};
 const receipt={format:1,id:randomUUID(),kind:'transition',markerSha256:auth.receipt.markerSha256,previousSha256:auth.sha256,from:select(f.a),to:select(f.b),pendingId:id,fenceId:activity.id,proof:{pending:p,nativeAck:p.nativeAck,readiness}};
 await f.store.choose(f.b);const sha=await f.fence.publish(receipt,'active',activity);await assert.rejects(f.fence.requireClean(select(f.b)),/unknown/);
 const current=await f.fence.activity();await f.fence.clean(current,{pid:123,code:0,signal:null,closed:true,selected:select(f.b)});assert.equal((await new RecoveredRuntimeFence(f.store).requireClean(select(f.b))).sha256,sha);
 assert.deepEqual(await readFile(join(f.user,'shutdown-failed.json')),f.marker);
});
