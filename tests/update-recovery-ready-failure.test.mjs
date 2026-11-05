import {RuntimeUpdates} from './update-publication-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Runtime} from '../dist/runtime.js';

import {select} from '../dist/update-store.js';
import {digest} from '../dist/update-format.js';
import {capableRecovered} from './update-recovery-fixture.mjs';

// Synthetic lineage/close records only; the packaged gate injects the actual post-transition startup failure.
async function failedReady(){
 const f=await capableRecovered(),prior=(await f.fence.lineage(f.capableSha)).receipt,p=structuredClone(prior.proof.pending),runtime=new Runtime(f.store.root(f.b.id),f.user),updates=new RuntimeUpdates(runtime,f.policy,async()=>false);updates.transaction=p;
 runtime.blockAmbiguousSave(Error('Synthetic failure after transition published but before playable-ready'));await runtime.verifyFailureGate();const marker=digest(await readFile(join(f.user,'shutdown-failed.json'))),pending=JSON.parse(await readFile(join(f.user,'runtime-pending.json')));
 const receipt={...f.receipt,id:randomUUID(),markerSha256:marker,previousSha256:f.capableSha,pendingId:p.id,fenceId:randomUUID(),proof:{...f.receipt.proof,pending}};receipt.proof.intentSha256=await f.fence.remember({format:1,id:randomUUID(),pendingSha256:await f.fence.rememberBytes(await readFile(join(f.user,'runtime-pending.json'))),oldActivitySha256:await f.fence.rememberBytes(await readFile(join(f.user,'runtime-activity.json'))),markerSha256:marker,previousSha256:f.capableSha,selected:p.to,prior:p.from,candidate:p.to,backupName:p.migrationName,backupSha256:receipt.proof.input.sha256,activityId:receipt.fenceId,target:'linux-x64'});return{...f,receipt};
}
test('update-recovery exact own ready-transition can precede explicit fixed-backup rollback after a new startup failure',async()=>{
 const f=await failedReady();await f.store.choose(f.a);const sha=await f.fence.publish(f.receipt,'clean');assert.equal((await f.fence.requireClean(select(f.a))).sha256,sha);assert.equal((await f.fence.lineage(sha)).receipt.previousSha256,f.capableSha);
});
for(const wrong of ['pending','backup','readiness','from'])test(`update-recovery foreign ${wrong} cannot use a published transition to authorize rollback`,async()=>{
 const f=await failedReady(),r=structuredClone(f.receipt),p=r.proof.pending;if(wrong==='pending'){p.id=randomUUID();r.pendingId=p.id;}if(wrong==='backup'){p.migrationName='foreign.sqlite';p.nativeAck.backup=join(f.user,'backups','foreign.sqlite');r.proof.input.name=p.migrationName;}if(wrong==='readiness')p.readiness.binarySha256='e'.repeat(64);if(wrong==='from'){p.from=select(f.b);r.to=select(f.b);}
 const sha=await f.fence.remember(r);await assert.rejects(f.fence.lineage(sha));assert.equal((await f.fence.pointer()).state,'retired');
});
