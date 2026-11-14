import {durableRecord,RuntimeUpdates} from './update-publication-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs,{readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Runtime} from '../dist/runtime.js';

import {AuthorityUnchangedError} from '../dist/saves.js';
import {select} from '../dist/update-store.js';
import {digest} from '../dist/update-format.js';
import {capableRecovered} from './update-recovery-fixture.mjs';

// Snapshot/close records below are synthetic unit inputs. Real Rust/StateLock/native proof is a separate packaged gate.
async function interrupted(){
 const f=await capableRecovered(),id=randomUUID(),selected=select(f.b),p={format:1,id,kind:'start',phase:'starting',from:selected,to:selected,preBackup:null,noDatabase:false,migrationName:'interrupted-unit-start.sqlite',pid:null,nativeAck:null,readiness:null,failureSha256:null,recovery:null};
 const old=await f.fence.active('server',selected,id);await durableRecord(join(f.user,'runtime-pending.json'),p);
 const original=await readFile(join(f.user,'runtime-pending.json')),oldBytes=await readFile(join(f.user,'runtime-activity.json'));
 const runtime=new Runtime(f.store.root(f.b.id),f.user),updates=new RuntimeUpdates(runtime,f.policy,async()=>true);await updates.startup();let calls=0;
 updates.snapshot=async(g,name)=>{calls++;const path=join(f.user,'backups',name),body=Buffer.from('synthetic NEWER committed-progress fixture');await mkdir(join(f.user,'backups'),{recursive:true});await writeFile(path,body);return{backup:{name,sha256:digest(body),metadata:{verified:true,schema:22,scope:'all-local-accounts',account_count:2,character_count:3},authority:select(g)},ack:{snapshot:path,verified:true}};};
 return{...f,p,old,original,oldBytes,runtime,updates,calls:()=>calls};
}
async function cold(f){const runtime=new Runtime(f.store.root(f.b.id),f.user),updates=new RuntimeUpdates(runtime,f.policy,async()=>true);await updates.startup();return{runtime,updates};}
test('update-current-recovery pre-child/unknown-spawn cut preserves exact startup/ACTIVE/marker/predecessors and captures newer current22 without replay',async()=>{
 const f=await interrupted(),profile=await readFile(join(f.user,'runtime-profile.json'));await f.updates.recover();assert.equal(f.calls(),1);const auth=await f.fence.requireClean(select(f.b));
 assert.equal(auth.receipt.kind,'current');assert.equal(auth.receipt.previousSha256,f.capableSha);assert.equal(auth.receipt.proof.snapshot.metadata.account_count,2);assert.equal(auth.receipt.proof.snapshot.metadata.character_count,3);assert.equal(auth.receipt.proof.interruptedStartup.outcome,'unknown');assert.equal(auth.receipt.proof.interruptedStartup.settlement,'current-validation');
 assert.deepEqual(await readFile(join(f.user,'runtime-recovery-history',auth.receipt.proof.interruptedStartup.sha256+'.json')),f.original);assert.deepEqual(await readFile(join(f.user,'runtime-recovery-history',auth.receipt.proof.oldActivitySha256+'.json')),f.oldBytes);
 assert.deepEqual(await readFile(join(f.user,'shutdown-failed.json')),f.marker);assert.deepEqual(await readFile(join(f.user,'runtime-profile.json')),profile);assert.equal(f.runtime.view().status,'stopped');assert.equal((await cold(f)).updates.view().phase,'ready');
});
test('update-current-recovery live-writer strict unchanged refusal preserves old pending/ACTIVE and requires another explicit fresh validation',async()=>{
 const f=await interrupted(),snapshot=f.updates.snapshot;f.updates.snapshot=async()=>{f.updates.recoveryAuthority={command:'snapshot',binary:join(f.store.root(f.b.id),'openrotmg'),code:2,outcome:'unchanged',ack:{protocol:1,operation:'snapshot',outcome:'unchanged',error:'synthetic unit lock refusal'}};throw new AuthorityUnchangedError('synthetic unit writer holds StateLock');};
 await assert.rejects(f.updates.recover(),/writer holds StateLock/);assert.deepEqual(await readFile(join(f.user,'runtime-pending.json')),f.original);assert.deepEqual(await readFile(join(f.user,'runtime-activity.json')),f.oldBytes);await assert.rejects(f.fence.requireClean(select(f.b)),/unknown/);
 f.updates.snapshot=snapshot;await f.updates.recover();assert.equal(f.calls(),1);await f.fence.requireClean(select(f.b));
});
for(const invalid of ['schema21','missing','corrupt','unknown'])test(`update-current-recovery ${invalid} cannot bless current startup or replay`,async()=>{
 const f=await interrupted(),snapshot=f.updates.snapshot;f.updates.snapshot=async(...args)=>{if(invalid==='schema21'){const value=await snapshot(...args);value.backup.metadata.schema=21;return value;}throw Error(`synthetic ${invalid} snapshot proof`);};
 await assert.rejects(f.updates.recover(),/target schema|synthetic/);await assert.rejects(f.fence.requireClean(select(f.b)),/unknown/);const reopened=await cold(f);assert.equal(reopened.updates.view().phase,'recovery');assert.equal(reopened.updates.view().canPlayInstalled,false);await assert.rejects(reopened.updates.recover(),/manual investigation/);
});
for(const wrong of ['update','restore','from-to','marker','predecessor','selection'])test(`update-current-recovery wrong ${wrong} never invokes current-save authority`,async()=>{
 const f=await interrupted();let p={...f.p};if(wrong==='update')p.kind='update';if(wrong==='restore'){p.phase='recovering';p.recovery={kind:'restore'};}if(wrong==='from-to')p.from=select(f.a);
 if(['update','restore','from-to'].includes(wrong))await durableRecord(join(f.user,'runtime-pending.json'),p);if(wrong==='marker')await writeFile(join(f.user,'shutdown-failed.json'),'foreign failure');if(wrong==='predecessor')await durableRecord(join(f.user,'runtime-activity.json'),{...f.old,receiptSha256:'f'.repeat(64)});if(wrong==='selection')await f.store.choose(f.a);
 await assert.rejects(f.updates.recover());assert.equal(f.calls(),0);assert.equal(f.updates.view().canPlayInstalled,false);
});
for(const cut of ['startup-archive','intent','active','receipt','receipt-pending','clean','pointer','disposition','archive'])test(`update-current-recovery write cut at ${cut} stays blocked or finalizes recorded proof without authority replay`,async t=>{
 const f=await interrupted(),rename=fs.rename,open=fs.open;let tripped=false;const fail=()=>{tripped=true;throw Object.assign(Error(`injected ${cut} ENOSPC`),{code:'ENOSPC'});};
 const createMock=t.mock.method(fs,'open',async(path,...args)=>{if(cut==='startup-archive'&&String(path).endsWith(digest(f.original)+'.json')&&!tripped)fail();const handle=await open(path,...args);if(cut==='receipt'&&String(path).includes('runtime-recovery-history')&&args[0]==='wx'){const write=handle.writeFile.bind(handle);handle.writeFile=async(data,...rest)=>{if(JSON.parse(data.toString()).kind==='current'&&!tripped)fail();return write(data,...rest);};}return handle;});
 const mock=t.mock.method(fs,'rename',async(from,to)=>{let value;try{value=JSON.parse(await readFile(from,'utf8'));}catch{}const match=cut==='intent'?to===join(f.user,'runtime-pending.json')&&value?.phase==='recovering':cut==='active'?to===join(f.user,'runtime-activity.json')&&value?.state==='active':cut==='receipt-pending'?to===join(f.user,'runtime-pending.json')&&value?.phase==='recovering'&&!!value?.recovery?.receiptSha256:cut==='clean'?to===join(f.user,'runtime-activity.json')&&value?.state==='clean':cut==='pointer'?to===join(f.user,'runtime-recovery.json'):cut==='disposition'?to===join(f.user,'runtime-pending.json')&&value?.phase==='recovered':cut==='archive'&&from===join(f.user,'runtime-pending.json')&&to.endsWith('.pending.json');if(match&&!tripped)fail();return rename(from,to);});
 await assert.rejects(f.updates.recover(),/ENOSPC/);mock.mock.restore();createMock.mock.restore();assert.equal(tripped,true);const reopened=await cold(f);assert.equal(reopened.updates.view().phase,'recovery');let replay=0;reopened.updates.snapshot=async()=>{replay++;throw Error('must never replay snapshot');};
 if(['startup-archive','intent'].includes(cut)){assert.equal(f.calls(),0);reopened.updates.snapshot=f.updates.snapshot;await reopened.updates.recover();assert.equal(f.calls(),1);}
 else if(['clean','pointer','disposition','archive'].includes(cut)){await reopened.updates.recover();await f.fence.requireClean(select(f.b));}else await assert.rejects(reopened.updates.recover());assert.equal(replay,0);
});
test('update-current-recovery NEW failure during commit retires the new receipt after bookkeeping and remains blocked cold',async t=>{
 const f=await interrupted(),rename=fs.rename;let failure;const mock=t.mock.method(fs,'rename',async(from,to)=>{const result=await rename(from,to);if(to===join(f.user,'runtime-recovery.json')&&!failure){f.runtime.blockAmbiguousSave(Error('new independent failure while committing repair'));failure=f.runtime.verifyFailureGate();}return result;});
 await assert.rejects(f.updates.recover(),/superseded|match|authorization|receipt/);await failure;mock.mock.restore();assert.equal((await f.fence.pointer()).state,'retired');await assert.rejects(f.fence.requireClean(select(f.b)));assert.equal((await cold(f)).updates.view().canPlayInstalled,false);
});
