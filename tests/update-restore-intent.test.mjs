import test from 'node:test';
import assert from 'node:assert/strict';
import fs,{readFile,writeFile,mkdir,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Runtime} from '../dist/runtime.js';
import {RuntimeUpdates} from '../dist/updates.js';
import saves from '../dist/saves.js';
import {AuthorityUnchangedError} from '../dist/saves.js';
import {durableRecord,select} from '../dist/update-store.js';
import {digest} from '../dist/update-format.js';
import {recovered} from './update-recovery-fixture.mjs';

// Synthetic native bytes/ACK/close fixtures only. No real Rust, SQL restore or native-platform qualification here.
async function fixture(t,oldState='active',confirm=true,mode='success'){
 const f=await recovered();let p={...structuredClone(f.p),id:randomUUID()},activity;const profile=await f.store.profile();profile.attempts.push({id:f.b.id,sequence:f.b.sequence});await durableRecord(join(f.user,'runtime-profile.json'),profile);await f.store.choose(f.b);
 if(oldState==='none'){await unlink(join(f.user,'runtime-recovery.json'));await unlink(join(f.user,'runtime-activity.json'));}
 else{activity=await f.fence.active('server',select(f.b),p.id,await f.fence.requireClean(select(f.a)));if(oldState==='clean')await f.fence.clean(activity,{pid:123,code:0,signal:null,closed:true,selected:select(f.b)});}
 const body=Buffer.from('synthetic full independent native backup'),input=join(f.user,'backups',p.migrationName);await mkdir(join(f.user,'backups'),{recursive:true});await writeFile(input,body);p.nativeAck.sha256=digest(body);await writeFile(input+'.ack.json',JSON.stringify(p.nativeAck));await durableRecord(join(f.user,'runtime-pending.json'),p);
 const runtime=new Runtime(f.store.root(f.b.id),f.user),updates=new RuntimeUpdates(runtime,f.policy,async()=>{const a=await f.fence.activity(),pending=JSON.parse(await readFile(join(f.user,'runtime-pending.json')));assert.equal(a.kind,'recovery');assert.equal(a.state,'active');assert.equal(pending.recovery.kind,'restore');return confirm;});updates.transaction=p;
 if(oldState!=='none'){runtime.blockAmbiguousSave(Error('synthetic failed candidate'));await runtime.verifyFailureGate();p=JSON.parse(await readFile(join(f.user,'runtime-pending.json')));}
 await updates.startup();const original=await readFile(join(f.user,'runtime-pending.json')),old=await f.fence.activity(),oldBytes=old?await readFile(join(f.user,'runtime-activity.json')):undefined;let calls=0,restores=0;
 const mock=t.mock.method(saves,'saveAuthority',async(authority,command,paths)=>{
  calls++;await authority.authorityStarting(command,authority.runtimePaths().binary);const active=await f.fence.activity();assert.equal(active.kind,'recovery');assert.equal(active.state,'active');assert.equal(active.pendingId,p.id);assert.equal(active.selected.id,f.b.id);
  if(mode==='unknown'){runtime.blockAmbiguousSave(Error('synthetic transport/ack unknown'));await runtime.verifyFailureGate();throw Error('synthetic transport/ack unknown');}
  if(mode==='unchanged'){const ack={protocol:1,operation:command,outcome:'unchanged',error:'synthetic strict refusal'};await authority.authorityClosed({command,binary:authority.runtimePaths().binary,code:2,outcome:'unchanged',ack});throw new AuthorityUnchangedError('synthetic strict unchanged');}
  let ack;if(command==='restore'){restores++;await writeFile(paths[3],Buffer.from('synthetic pre-restore full snapshot'));ack={restored:true,backup:paths[3]};}else{assert.equal(command,'verify-snapshot');ack={verified:true,schema:22,scope:'all-local-accounts',account_count:1,character_count:1};}
  await authority.authorityClosed({command,binary:authority.runtimePaths().binary,code:0,outcome:'success',ack});return ack;
 });
 return{...f,p,runtime,updates,original,oldBytes,calls:()=>calls,restores:()=>restores,mock};
}
for(const old of ['none','active','clean'])test(`update-restore-intent ${old} predecessor is bound and ACTIVE before the first authority until real-proof finalization`,async t=>{
 const f=await fixture(t,old);await f.updates.recover();assert.equal(f.restores(),1);const auth=await f.fence.requireClean(select(f.a)),intent=await f.fence.evidence(auth.receipt.proof.intentSha256);assert.deepEqual(await readFile(join(f.user,'runtime-recovery-history',intent.pendingSha256+'.json')),f.original);if(f.oldBytes)assert.deepEqual(await readFile(join(f.user,'runtime-recovery-history',intent.oldActivitySha256+'.json')),f.oldBytes);else assert.equal(intent.oldActivitySha256,null);assert.equal((await f.fence.activity()).state,'clean');
});
for(const mode of ['cancel','unchanged'])test(`update-restore-intent ${mode} settles only the new attempt back to exact failed barrier`,async t=>{
 const f=await fixture(t,'clean',mode!=='cancel',mode==='unchanged'?'unchanged':'success');if(mode==='cancel')await f.updates.recover();else await assert.rejects(f.updates.recover(),/unchanged/);assert.deepEqual(await readFile(join(f.user,'runtime-pending.json')),f.original);assert.deepEqual(await readFile(join(f.user,'runtime-activity.json')),f.oldBytes);assert.equal((await f.fence.pointer()).state,'retired');assert.equal(f.restores(),0);assert.equal(f.calls(),mode==='cancel'?0:1);assert.equal(f.updates.view().canPlayInstalled,false);
});
for(const state of ['none','active'])test(`update-restore-intent cancel preserves exact ${state} original barrier without invoking authority`,async t=>{const f=await fixture(t,state,false);await f.updates.recover();assert.equal(f.calls(),0);assert.deepEqual(await readFile(join(f.user,'runtime-pending.json')),f.original);if(f.oldBytes)assert.deepEqual(await readFile(join(f.user,'runtime-activity.json')),f.oldBytes);else assert.equal(await f.fence.activity(),undefined);assert.equal(f.updates.view().canPlayInstalled,false);});
test('update-restore-intent unknown authority completion preserves ACTIVE, new failure and blocked cold replay',async t=>{
 const f=await fixture(t,'clean',true,'unknown');await assert.rejects(f.updates.recover(),/unknown/);assert.equal((await f.fence.activity()).state,'active');assert.equal((await f.fence.pointer()).state,'retired');const cold=new Runtime(f.store.root(f.b.id),f.user),updates=new RuntimeUpdates(cold,f.policy,async()=>true);assert.equal((await updates.startup()).phase,'recovery');await assert.rejects(updates.recover(),/manual investigation/);assert.equal(f.restores(),0);
});
for(const cut of ['intent','active','proof','selection','pointer','disposition','clean','archive'])test(`update-restore-intent ${cut} cut blocks or finalizes complete proof without replay`,async t=>{
 const f=await fixture(t),rename=fs.rename,link=fs.link;let hit=false;const fail=()=>{hit=true;throw Object.assign(Error('injected restore '+cut+' ENOSPC'),{code:'ENOSPC'});};
 const a=t.mock.method(fs,'rename',async(from,to)=>{let value;try{value=JSON.parse(await readFile(from,'utf8'));}catch{}const match=cut==='intent'?to===join(f.user,'runtime-pending.json')&&value?.phase==='recovering':cut==='active'?to===join(f.user,'runtime-activity.json')&&value?.state==='active'&&value?.proof?.intent:cut==='selection'?to===join(f.user,'runtime-selection.json'):cut==='pointer'?to===join(f.user,'runtime-recovery.json'):cut==='disposition'?to===join(f.user,'runtime-pending.json')&&value?.phase==='recovered':cut==='clean'?to===join(f.user,'runtime-activity.json')&&value?.state==='clean':cut==='archive'&&from===join(f.user,'runtime-pending.json')&&to.endsWith('.pending.json');if(match&&!hit)fail();return rename(from,to);});
 const b=t.mock.method(fs,'link',async(from,to)=>{if(cut==='proof'&&!hit&&String(to).includes('runtime-recovery-history')){const value=JSON.parse(await readFile(from,'utf8'));if(value.kind==='restore')fail();}return link(from,to);});
 await assert.rejects(f.updates.recover(),/ENOSPC/);a.mock.restore();b.mock.restore();assert.equal(hit,true);const count=f.calls(),cold=new Runtime(f.store.root(f.b.id),f.user),updates=new RuntimeUpdates(cold,f.policy,async()=>true);assert.equal((await updates.startup()).phase,'recovery');
 if(['selection','pointer','disposition','clean','archive'].includes(cut)){await updates.recover();assert.equal(f.calls(),count);await f.fence.requireClean(select(f.a));}else if(cut!=='intent'){await assert.rejects(updates.recover());assert.equal(f.calls(),count);}assert.equal(updates.view().canPlayInstalled,false);
});
