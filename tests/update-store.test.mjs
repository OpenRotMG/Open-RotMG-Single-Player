import test from 'node:test';
import assert from 'node:assert/strict';
import fs,{mkdir,readFile,writeFile,unlink,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {RuntimeStore,record,selection} from '../dist/update-store.js';
import {digest} from '../dist/update-format.js';
import {directory,unitRuntime,keyPair,publicPEM,signed,manifestFor} from './update-fixture.mjs';

async function fixture(){
 const root=await directory('update-store'),bundle=join(root,'bundle'),user=join(root,'user');await unitRuntime(bundle,{legacy:true});await mkdir(user);
 const policy={target:'linux-x64',launcher:'0.1.0',baseline:{root:bundle,mode:'source',startupBackup:0,clientNamespace:0,identitySha256:digest(await readFile(join(bundle,'build-identity.json')))},publicKey:publicPEM(keyPair()),assetOrigin:'https://github.com'};
 return{root,bundle,user,policy,store:new RuntimeStore(user,policy)};
}
test('update-store source0 bootstrap deliberately persists a whole immutable generation and explicit anchor',async()=>{
 const f=await fixture(),r=await f.store.initialize();assert.equal(r.profile.initialized,true);assert.equal(r.selected.sequence,0);assert.equal(r.selected.kind,'source');assert.equal(r.selected.startupBackup,0);
 const selection=await record(join(f.user,'runtime-selection.json'));assert.equal(selection.id,r.selected.id);
 assert.equal((await f.store.load(selection)).binarySha256,r.selected.binarySha256);
 assert.equal(await readFile(join(f.store.root(r.selected.id),'client/launcher.js'),'utf8'),'unit launcher.js');
});
test('update-store manual installer upgrade never redirects an anchored old baseline to new bundle bytes',async()=>{
 const f=await fixture(),a=await f.store.initialize(),bundleB=join(f.root,'bundle-B');await unitRuntime(bundleB,{serverCommit:'6'.repeat(40),clientCommit:'7'.repeat(40),legacy:true});
 const next=new RuntimeStore(f.user,{...f.policy,baseline:{root:bundleB,mode:'source',startupBackup:0,clientNamespace:0,identitySha256:digest(await readFile(join(bundleB,'build-identity.json')))}});
 const reopened=await next.initialize();assert.equal(reopened.selected.id,a.selected.id);assert.equal(reopened.selected.pins.server.commit,'1'.repeat(40));assert.equal(reopened.selected.pins.client.commit,'2'.repeat(40));
});
test('update-store missing/corrupt authoritative selection refuses rather than falling back to baseline',async()=>{
 for(const mode of ['missing','corrupt']){const f=await fixture();await f.store.initialize();const path=join(f.user,'runtime-selection.json');if(mode==='missing')await unlink(path);else await writeFile(path,'{bad');await assert.rejects(f.store.initialize());assert.equal((await f.store.profile()).initialized,true);}
});
test('update-store loss of bootstrap anchor with any managed evidence is an explicit error',async()=>{
 const f=await fixture();await f.store.initialize();await unlink(join(f.user,'runtime-profile.json'));await assert.rejects(f.store.initialize(),/anchor is missing/);
 const other=await fixture();await mkdir(join(other.user,'runtime-manifests'));await assert.rejects(other.store.initialize(),/anchor is missing/);
});
test('update-store interrupted bootstrap resumes only the exact recorded generation, never replacement installer bytes',async t=>{
 const f=await fixture(),rename=fs.rename;let profiles=0;
 const mock=t.mock.method(fs,'rename',async(from,to)=>{if(to===join(f.user,'runtime-profile.json')&&++profiles===1)throw Object.assign(Error('injected cut before initialized anchor'),{code:'EIO'});return rename(from,to);});
 await assert.rejects(f.store.initialize(),/injected cut/);mock.mock.restore();assert.equal((await f.store.profile()).initialized,false);
 const reopened=await f.store.initialize();assert.equal(reopened.profile.initialized,true);assert.equal(reopened.selected.id,(await f.store.profile()).baseline.id);
});
test('update-store interrupted pre-copy bootstrap cannot substitute a different installer',async t=>{
 const f=await fixture(),mkdir=fs.mkdir;const mock=t.mock.method(fs,'mkdir',async(path,...args)=>{if(path===f.store.staging)throw Error('injected pre-copy cut');return mkdir(path,...args);});
 await assert.rejects(f.store.initialize(),/injected pre-copy cut/);mock.mock.restore();assert.equal((await f.store.profile()).initialized,false);
 const b=join(f.root,'bundle-B');await unitRuntime(b,{serverCommit:'8'.repeat(40),legacy:true});const next=new RuntimeStore(f.user,{...f.policy,baseline:{root:b,mode:'source',startupBackup:0,clientNamespace:0,identitySha256:digest(await readFile(join(b,'build-identity.json')))}});
 await assert.rejects(next.initialize(),/different installer/);assert.equal((await f.store.profile()).initialized,false);
});
test('update-store remembers exact signed sequence identity and rejects same-sequence replacement',async()=>{
 const f=await fixture();await f.store.initialize();const m=await manifestFor(f.bundle,join(f.root,'payload.tar.gz')),keys=keyPair(),a=signed(m,keys);await f.store.remember(a.bytes,a.signature,m);await f.store.remember(a.bytes,a.signature,m);
 const changed=structuredClone(m);changed.payload.sha256='f'.repeat(64);const b=signed(changed,keys);await assert.rejects(f.store.remember(b.bytes,b.signature,changed),/different manifest identity/);
 assert.equal((await readdir(join(f.user,'runtime-manifests'))).length,2);
});
test('update-store rejects renderer-like selection paths and unsupported generation spelling',()=>{
 for(const id of ['../escape','/root','C:\\escape','source-xxx','release-0-'+'a'.repeat(64)])assert.throws(()=>selection({format:1,id,descriptorSha256:'a'.repeat(64)}));
});
