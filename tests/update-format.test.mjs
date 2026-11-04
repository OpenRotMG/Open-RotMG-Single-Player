import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFile,writeFile,symlink} from 'node:fs/promises';
import {verifyManifest,verifyRuntime,portablePath,targetName,digest,RELEASES_PAGE} from '../dist/update-format.js';
import {MANIFEST_PUBLIC_KEY} from '../dist/update-policy.js';
import {directory,unitRuntime,manifestFor,keyPair,publicPEM,signed} from './update-fixture.mjs';

test('update-format pins the parent-approved public Ed25519 key and native targets',()=>{
 assert.equal(digest(MANIFEST_PUBLIC_KEY),'5038cb15fb3673dbb2042a3c77cd53c86b624948dfcd1da9f96403fc4d6ac07c');
 for(const[p,a]of[['linux','x64'],['win32','x64'],['darwin','arm64']])assert.equal(targetName(p,a),`${p}-${a}`);
 assert.throws(()=>targetName('darwin','x64'),/Unsupported runtime target/);
});
test('update-format authenticates exact bytes, fixed generation, pair, target and known save protocol before use',async()=>{
 const root=await directory('update-format'),identity=await unitRuntime(root),manifest=await manifestFor(root,join(root,'payload.tar.gz')),keys=keyPair(),key=publicPEM(keys);
 const check=value=>{const s=signed(value,keys);return verifyManifest(s.bytes,s.signature,key,manifest.releaseId,manifest.tag,'linux-x64','0.1.0');};
 assert.deepEqual(check(manifest),manifest);const s=signed(manifest,keys);
 assert.throws(()=>verifyManifest(Buffer.concat([s.bytes,Buffer.from(' ')]),s.signature,key,manifest.releaseId,manifest.tag,'linux-x64','0.1.0'),/signature verification/);
 assert.throws(()=>verifyManifest(s.bytes,s.signature,publicPEM(keyPair()),manifest.releaseId,manifest.tag,'linux-x64','0.1.0'),/signature verification/);
 assert.throws(()=>verifyManifest(s.bytes,s.signature.subarray(1),key,manifest.releaseId,manifest.tag,'linux-x64','0.1.0'),/signature size/);
 for(const mutate of [m=>m.format=2,m=>m.sequence=0,m=>m.sequence=1.5,m=>m.releaseId++,m=>m.tag='fixture-other',m=>m.target='win32-x64',m=>m.keyId='untrusted future key',m=>m.payload.sha256='x'.repeat(64),m=>m.payload.bytes=536870913,m=>m.payload.expandedBytes=2147483649,m=>m.save.cli=2,m=>m.save.read=[21,22,23],m=>m.save.write=23,m=>m.pins.client.repository='https://evil.invalid/client',m=>m.pins.server.commit='main',m=>m.pins.ruffle.version='https://evil.invalid',m=>m.payload.installerURL='https://evil.invalid']){
  const bad=structuredClone(manifest);mutate(bad);assert.throws(()=>check(bad));
 }
 const oldLauncher=structuredClone(manifest);oldLauncher.minLauncher='0.2.0';assert.throws(()=>check(oldLauncher),e=>e.kind==='launcher'&&e.message.includes(RELEASES_PAGE));
 assert.equal(check(manifest).pins.server.commit,identity.pins.server.commit);
});
test('update-format raw paths reject traversal, drive/UNC/ADS, reserved names and nonportable aliases',()=>{
 for(const path of ['/client/x','../client/x','./client/x','client/../x','client//x','client/x/','C:/x','C:relative','\\\\server\\share','client\\x','client/file:stream','client/con.txt','client/LPT9','client/trailing.','client/trailing ','client/%2e%2e/x','client/\0x','client/é.js'])assert.throws(()=>portablePath(path),undefined,path);
 for(const path of ['client/vendor/ruffle.123.js','data/Realm_1.xml','notices/CLIENT-GPL-3.0'])assert.doesNotThrow(()=>portablePath(path));
});
test('update-format verifies native header, full inventory, declared data/client/Ruffle and revision bindings',async()=>{
 const root=await directory('update-inventory'),identity=await unitRuntime(root),manifest=await manifestFor(root,join(await directory('update-payload'),'payload.tar.gz'));
 assert.deepEqual(await verifyRuntime(root,'linux-x64',manifest),identity);
 await writeFile(join(root,'client','launcher.js'),'tampered');await assert.rejects(verifyRuntime(root,'linux-x64',manifest),/digest mismatch/);
 const other=await directory('update-extra');await unitRuntime(other);await writeFile(join(other,'client','extra.js'),'not inventoried');await assert.rejects(verifyRuntime(other,'linux-x64'),/extra files/);
 const mismatch=structuredClone(manifest);mismatch.payload.identitySha256='f'.repeat(64);await assert.rejects(verifyRuntime(await restored(),'linux-x64',mismatch),/Signed pair differs/);
 async function restored(){const r=await directory('update-identity');await unitRuntime(r);return r;}
});
test('update-format refuses symlinks before inventory traversal', {skip:process.platform==='win32'},async()=>{
 const root=await directory('update-links');await unitRuntime(root);await symlink('/tmp',join(root,'client','escape'));await assert.rejects(verifyRuntime(root,'linux-x64'),/links are forbidden/);
});
