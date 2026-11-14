import {RuntimeStore,RuntimeUpdates} from './update-publication-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {Runtime} from '../dist/runtime.js';


import {authenticateManifest,digest,verifyManifest} from '../dist/update-format.js';
import {directory,unitRuntime,keyPair,publicPEM,manifestFor,signed} from './update-fixture.mjs';

test('update-sequence authenticated but incompatible future bytes retain highwater and exact positive identity across restart',async()=>{
 const root=await directory('update-sequence'),bundle=join(root,'bundle');await unitRuntime(bundle);const keys=keyPair(),policy={target:'linux-x64',launcher:'0.1.0',publicKey:publicPEM(keys),assetOrigin:'https://github.com',baseline:{root:bundle,mode:'source',startupBackup:1,clientNamespace:1,identitySha256:digest(await readFile(join(bundle,'build-identity.json')))}};
 const store=new RuntimeStore(join(root,'user'),policy);await store.initialize();const m=await manifestFor(bundle,join(root,'a.tar.gz'),'https://github.com',3);m.format=2;const a=signed(m,keys),header=authenticateManifest(a.bytes,a.signature,policy.publicKey,m.releaseId,m.tag);await store.remember(a.bytes,a.signature,header);assert.throws(()=>verifyManifest(a.bytes,a.signature,policy.publicKey,m.releaseId,m.tag,'linux-x64','0.1.0','https://github.com'),/future/);assert.equal(await new RuntimeStore(store.userData,policy).authenticatedFloor(),3);
 m.format=1;const b=signed(m,keys);await assert.rejects(store.remember(b.bytes,b.signature,m),/different manifest identity/);await unlink(join(store.userData,'runtime-manifests',`3-${digest(a.bytes)}.sig`));await assert.rejects(store.authenticatedFloor(),/incomplete/);
});
test('update-refusal cold offline check cannot erase an earlier service/signature refusal or automatically execute old code',async()=>{
 const root=await directory('update-refusal'),bundle=join(root,'bundle');await unitRuntime(bundle);const keys=keyPair(),policy={target:'linux-x64',launcher:'0.1.0',publicKey:publicPEM(keys),assetOrigin:'https://github.com',discovery:'https://api.github.com/repos/OpenRotMG/Open-RotMG-Single-Player/releases/latest',redirectOrigins:['https://api.github.com','https://github.com'],metadataDeadline:1000,payloadIdleDeadline:1000,payloadDeadline:1000,request:async()=>new Response('service',{status:503}),baseline:{root:bundle,mode:'source',startupBackup:1,clientNamespace:1,identitySha256:digest(await readFile(join(bundle,'build-identity.json')))}};
 const user=join(root,'user'),first=new Runtime(bundle,user),updates=new RuntimeUpdates(first,policy,async()=>false);assert.equal((await updates.startup()).phase,'ready');assert.equal((await updates.check()).phase,'service');const refusal=await readFile(join(user,'runtime-check-refusal.json'));
 const cold=new Runtime(bundle,user),next=new RuntimeUpdates(cold,{...policy,request:async()=>{throw Object.assign(Error('synthetic offline'),{cause:{code:'ENETUNREACH'}});}},async()=>false);assert.equal((await next.startup()).phase,'service');assert.equal((await next.check()).phase,'unavailable');await assert.rejects(cold.start(),/prior refused|old-code fallback/);assert.equal(cold.view().pid,undefined);assert.equal(cold.view().status,'stopped');assert.equal(next.view().canPlayInstalled,true);assert.deepEqual(await readFile(join(user,'runtime-check-refusal.json')),refusal);
 await writeFile(join(user,'runtime-check-refusal.json'),'{bad');const broken=new Runtime(bundle,user),bad=new RuntimeUpdates(broken,policy,async()=>false);assert.equal((await bad.startup()).phase,'recovery');assert.equal(bad.view().canPlayInstalled,false);
});
