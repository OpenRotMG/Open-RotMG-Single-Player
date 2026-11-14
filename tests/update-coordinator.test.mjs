import {RuntimeUpdates} from './update-publication-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Runtime} from '../dist/runtime.js';

import {digest,UpdateProblem} from '../dist/update-format.js';
import {runtimeFixture} from '../scripts/runtime-update-fixture.mjs';
import {directory,unitRuntime,manifestFor} from './update-fixture.mjs';

// Synthetic nonexecutable runtime bodies exercise coordinator/network/lifecycle hashing, not native gameplay or migrations.
async function setup(t,schema=22){
 const out=await directory('update-coordinator'),base=join(out,'baseline'),candidate=join(out,'candidate');await unitRuntime(base);await unitRuntime(candidate,{serverCommit:'8'.repeat(40),data:'different synthetic domain data',schema});
 const archive=join(out,'candidate.tar.gz'),m=await manifestFor(candidate,archive),fixture=await runtimeFixture({out,runtime:candidate,archive,target:'linux-x64',archiveInfo:{target:'linux-x64',pins:m.pins,startupBackup:1,clientNamespace:1,payload:m.payload}});t.after(()=>fixture.close());
 const policy={...fixture.policy({root:base,mode:'source',startupBackup:1,clientNamespace:1,identitySha256:digest(await readFile(join(base,'build-identity.json')))}),launcher:'0.1.1'},runtime=new Runtime(base,join(out,'profile')),updates=new RuntimeUpdates(runtime,policy,async()=>false);return{out,base,candidate,fixture,policy,runtime,updates};
}
async function wait(action){for(let n=0;n<200;n++){if(await action())return;await delay(10);}throw Error('Coordinator test condition did not settle');}
test('startup makes no update requests; explicit repeated requests coalesce and select one verified pair without claiming native readiness',async t=>{
 const f=await setup(t);f.fixture.set('good');f.fixture.hold();await f.updates.startup();assert.equal(f.fixture.requests.length,0);const automatic=f.updates.check(),manual=f.updates.check();assert.equal(automatic,manual);await wait(()=>f.fixture.held()===1);assert.equal(f.updates.check(),manual);f.fixture.release();await automatic;
 assert.equal(f.fixture.requests.filter(r=>r.path.endsWith('/latest')).length,1);assert.equal(f.fixture.requests.filter(r=>r.path.endsWith('.tar.gz')).length,1);assert.equal(f.fixture.errors.length,0);assert.equal(f.updates.view().phase,'staged');assert.equal(f.updates.view().installed.server,'1'.repeat(40));assert.equal(f.updates.view().available.server,'8'.repeat(40));assert.equal(f.runtime.view().pid,undefined);const pending=JSON.parse(await readFile(join(f.runtime.userData,'runtime-pending.json')));assert.equal(pending.phase,'selected');assert.equal(pending.pid,null);assert.equal(pending.readiness,null);assert.equal(pending.noDatabase,true);await f.runtime.close();
});
test('Play preparation only verifies installed files and takes no network update action',async t=>{
 const f=await setup(t);await f.updates.startup();await f.runtime.idleOperation('Explicit Play preparation',()=>f.updates.beforeStart(false));assert.equal(f.fixture.requests.length,0);assert.equal(f.updates.view().needsStart,true);await f.runtime.close();
});
for(const newer of [false,true])test(`verified explicit update retires its old refusal only when no newer authenticated floor remains (${newer})`,async t=>{
 const f=await setup(t);f.fixture.set('good');await f.updates.startup();await f.updates.check();const current=f.updates.current,p=f.updates.transaction;await f.updates.recordRefusal(new UpdateProblem('rejected','previous candidate refusal'));f.updates.transaction={...p,phase:'starting',pid:123};f.updates.captureNative=async p=>({pending:{...p,nativeAck:{protocol:1,operation:'pre-migration',process:123,backup:join(f.runtime.userData,'backups',p.migrationName),sha256:null,source_schema:null,target_schema:22,outcome:'no-game-db'}},backup:null});f.runtime.ownsLiveChild=pid=>pid===123;f.runtime.status='starting';if(newer)t.mock.method(f.updates.store,'authenticatedFloor',async()=>current.sequence+1);
 await f.updates.ready({pid:123,healthProcess:123,listenerSeen:true,resources:f.updates.store.root(current.id),binary:f.runtime.runtimePaths().binary});const path=join(f.runtime.userData,'runtime-check-refusal.json');if(newer)assert.match(await readFile(path,'utf8'),/previous candidate refusal/);else await assert.rejects(readFile(path),{code:'ENOENT'});
});
test('selected startup blocks import before the chooser, preserves pending evidence and explains the missing Start',async t=>{
 const f=await setup(t);f.fixture.set('good');await f.updates.startup();await f.updates.check();const path=join(f.runtime.userData,'runtime-pending.json'),before=await readFile(path);let chosen=false;
 assert.equal(f.updates.view().canManageSaves,false);assert.equal(f.updates.view().needsStart,true);
 await assert.rejects(f.runtime.stoppedOperation('Import player',async()=>{chosen=true;}),/Click Play/);
 assert.equal(chosen,false);assert.deepEqual(await readFile(path),before);assert.equal(f.runtime.view().pid,undefined);assert.equal(f.runtime.view().status,'stopped');await f.runtime.close();
});
test('negative capability fixture cannot contaminate later valid checks or authenticated source counts',async t=>{
 const f=await setup(t,23);f.fixture.set('legacy-capability');assert.equal(f.fixture.current().save.startupBackup,0);f.fixture.set('good');assert.equal(f.fixture.current().save.startupBackup,1);await f.updates.startup();await f.updates.check();assert.equal(f.updates.view().phase,'staged');assert.equal(f.updates.view().available.serverCount,10);assert.equal(f.updates.view().available.clientCount,20);await f.runtime.close();
});
test('update-coordinator discovers/stages during an existing lifecycle reservation, never drains it, and activates only on idle',async t=>{
 const f=await setup(t);await f.updates.startup();const original=await readFile(join(f.runtime.userData,'runtime-selection.json'));let release,entered;const inside=new Promise(ok=>entered=ok),hold=new Promise(ok=>release=ok),operation=f.runtime.idleOperation('Unit held lifecycle',async()=>{entered();await hold;});await inside;f.fixture.set('good');await f.updates.check();
 assert.equal(f.updates.view().phase,'staged');assert.equal(f.runtime.view().operation,'Unit held lifecycle');assert.deepEqual(await readFile(join(f.runtime.userData,'runtime-selection.json')),original);release();await operation;await f.updates.settle();assert.equal(JSON.parse(await readFile(join(f.runtime.userData,'runtime-pending.json'))).phase,'selected');await f.runtime.close();
});
test('update-coordinator pre-Start reuses the explicit pending check and Close aborts/settles it before any server invocation',async t=>{
 const f=await setup(t);f.fixture.set('good');f.fixture.hold();await f.updates.startup();const automatic=f.updates.check();await wait(()=>f.fixture.held()===1);const manual=f.updates.check();assert.equal(manual,automatic);const start=f.runtime.start().then(()=>{throw Error('Synthetic server must never execute');},error=>error);await delay(20);assert.equal(f.fixture.requests.length,1);const close=f.runtime.close();await close;assert.match(String(await start),/cancel|closing|aborted/i);await automatic;
 assert.equal(f.runtime.view().status,'stopped');assert.equal(f.runtime.view().pid,undefined);assert.equal(f.fixture.requests.filter(r=>r.path.endsWith('.tar.gz')).length,0);await assert.rejects(readFile(join(f.runtime.userData,'shutdown-failed.json')),e=>e.code==='ENOENT');
});
test('update-coordinator whole-pair client namespace changes for server/data-only pair while client bytes/revision remain identical',async t=>{
 const f=await setup(t);await f.updates.startup();const before=f.updates.clientURL();assert.match(before,/\/_runtime\/[a-f0-9]{64}\/$/);const baseIdentity=JSON.parse(await readFile(join(f.base,'build-identity.json'))),candidateIdentity=JSON.parse(await readFile(join(f.candidate,'build-identity.json')));assert.deepEqual(baseIdentity.pins.client,candidateIdentity.pins.client);assert.notEqual(baseIdentity.pins.server.dataSha256,candidateIdentity.pins.server.dataSha256);assert.equal(baseIdentity.binarySha256,candidateIdentity.binarySha256);
 f.fixture.set('good');await f.updates.check();assert.notEqual(f.updates.clientURL(),before);assert.equal(f.updates.startupConfig().client_generation,digest(await readFile(join(f.candidate,'build-identity.json'))));await f.runtime.close();
});
