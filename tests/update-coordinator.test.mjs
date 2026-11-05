import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Runtime} from '../dist/runtime.js';
import {RuntimeUpdates} from '../dist/updates.js';
import {digest} from '../dist/update-format.js';
import {runtimeFixture} from '../scripts/runtime-update-fixture.mjs';
import {directory,unitRuntime,manifestFor} from './update-fixture.mjs';

// Synthetic nonexecutable runtime bodies exercise coordinator/network/lifecycle hashing, not native gameplay or migrations.
async function setup(t){
 const out=await directory('update-coordinator'),base=join(out,'baseline'),candidate=join(out,'candidate');await unitRuntime(base);await unitRuntime(candidate,{serverCommit:'8'.repeat(40),data:'different synthetic domain data'});
 const archive=join(out,'candidate.tar.gz'),m=await manifestFor(candidate,archive),fixture=await runtimeFixture({out,runtime:candidate,archive,target:'linux-x64',archiveInfo:{target:'linux-x64',pins:m.pins,startupBackup:1,clientNamespace:1,payload:m.payload}});t.after(()=>fixture.close());
 const policy={...fixture.policy({root:base,mode:'source',startupBackup:1,clientNamespace:1,identitySha256:digest(await readFile(join(base,'build-identity.json')))}),launcher:'0.1.0'},runtime=new Runtime(base,join(out,'profile')),updates=new RuntimeUpdates(runtime,policy,async()=>false);return{out,base,candidate,fixture,policy,runtime,updates};
}
async function wait(action){for(let n=0;n<200;n++){if(await action())return;await delay(10);}throw Error('Coordinator test condition did not settle');}
test('update-coordinator coalesces automatic/manual requests and selects one verified pair without claiming native readiness',async t=>{
 const f=await setup(t);f.fixture.set('good');f.fixture.hold();const automatic=f.updates.startup(),manual=f.updates.check();assert.equal(automatic,manual);await wait(()=>f.fixture.held()===1);assert.equal(f.updates.check(),manual);f.fixture.release();await automatic;
 assert.equal(f.fixture.requests.filter(r=>r.path.endsWith('/latest')).length,1);assert.equal(f.fixture.requests.filter(r=>r.path.endsWith('.tar.gz')).length,1);assert.equal(f.fixture.errors.length,0);assert.equal(f.updates.view().phase,'staged');assert.equal(f.updates.view().installed.server,'1'.repeat(40));assert.equal(f.updates.view().available.server,'8'.repeat(40));assert.equal(f.runtime.view().pid,undefined);const pending=JSON.parse(await readFile(join(f.runtime.userData,'runtime-pending.json')));assert.equal(pending.phase,'selected');assert.equal(pending.pid,null);assert.equal(pending.readiness,null);assert.equal(pending.noDatabase,true);await f.runtime.close();
});
test('update-coordinator discovers/stages during an existing lifecycle reservation, never drains it, and activates only on idle',async t=>{
 const f=await setup(t);await f.updates.startup();const original=await readFile(join(f.runtime.userData,'runtime-selection.json'));let release,entered;const inside=new Promise(ok=>entered=ok),hold=new Promise(ok=>release=ok),operation=f.runtime.idleOperation('Unit held lifecycle',async()=>{entered();await hold;});await inside;f.fixture.set('good');await f.updates.check();
 assert.equal(f.updates.view().phase,'staged');assert.equal(f.runtime.view().operation,'Unit held lifecycle');assert.deepEqual(await readFile(join(f.runtime.userData,'runtime-selection.json')),original);release();await operation;await wait(async()=>{try{return JSON.parse(await readFile(join(f.runtime.userData,'runtime-pending.json'))).phase==='selected';}catch{return false;}});await f.updates.settle();await f.runtime.close();
});
test('update-coordinator pre-Start reuses pending automatic/manual check and Close aborts/settles it before any server invocation',async t=>{
 const f=await setup(t);f.fixture.set('good');f.fixture.hold();const automatic=f.updates.startup();await wait(()=>f.fixture.held()===1);const manual=f.updates.check();assert.equal(manual,automatic);const start=f.runtime.start().then(()=>{throw Error('Synthetic server must never execute');},error=>error);await delay(20);assert.equal(f.fixture.requests.length,1);const close=f.runtime.close();await close;assert.match(String(await start),/cancel|closing|aborted/i);await automatic;
 assert.equal(f.runtime.view().status,'stopped');assert.equal(f.runtime.view().pid,undefined);assert.equal(f.fixture.requests.filter(r=>r.path.endsWith('.tar.gz')).length,0);await assert.rejects(readFile(join(f.runtime.userData,'shutdown-failed.json')),e=>e.code==='ENOENT');
});
test('update-coordinator whole-pair client namespace changes for server/data-only pair while client bytes/revision remain identical',async t=>{
 const f=await setup(t);await f.updates.startup();const before=f.updates.clientURL();assert.match(before,/\/_runtime\/[a-f0-9]{64}\/$/);const baseIdentity=JSON.parse(await readFile(join(f.base,'build-identity.json'))),candidateIdentity=JSON.parse(await readFile(join(f.candidate,'build-identity.json')));assert.deepEqual(baseIdentity.pins.client,candidateIdentity.pins.client);assert.notEqual(baseIdentity.pins.server.dataSha256,candidateIdentity.pins.server.dataSha256);assert.equal(baseIdentity.binarySha256,candidateIdentity.binarySha256);
 f.fixture.set('good');await f.updates.check();assert.notEqual(f.updates.clientURL(),before);assert.equal(f.updates.startupConfig().client_generation,digest(await readFile(join(f.candidate,'build-identity.json'))));await f.runtime.close();
});
