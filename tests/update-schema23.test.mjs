import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {verifyManifest,verifyRuntime,runtimeSaveSchema,minimumRuntimeLauncher} from '../dist/update-format.js';
import {nativeAck} from '../dist/update-journal.js';
import {snapshotPreview} from '../dist/saves.js';
import {directory,unitRuntime,manifestFor,keyPair,publicPEM,signed} from './update-fixture.mjs';

test('schema23 remains signed, requires the new launcher and must match the actual runtime capability notice',async()=>{
 const root=await directory('schema23');await unitRuntime(root,{schema:23});const m=await manifestFor(root,join(await directory('schema23-payload'),'runtime.tar.gz'));
 m.save={cli:1,read:[21,22,23],write:23,startupBackup:1};m.minLauncher='0.1.1';const keys=keyPair(),s=signed(m,keys),key=publicPEM(keys);
 assert.equal(verifyManifest(s.bytes,s.signature,key,m.releaseId,m.tag,'linux-x64','0.1.1','https://github.com').save.write,23);
 assert.throws(()=>verifyManifest(s.bytes,s.signature,key,m.releaseId,m.tag,'linux-x64','0.1.0','https://github.com'),error=>error.kind==='launcher');
 const noCounts=structuredClone(m);delete noCounts.pins.server.commitCount;delete noCounts.pins.client.commitCount;const missing=signed(noCounts,keys);assert.throws(()=>verifyManifest(missing.bytes,missing.signature,key,m.releaseId,m.tag,'linux-x64','0.1.1','https://github.com'),/source commit counts/);
 const underdeclared=signed({...m,minLauncher:'0.1.0'},keys);assert.throws(()=>verifyManifest(underdeclared.bytes,underdeclared.signature,key,m.releaseId,m.tag,'linux-x64','0.1.1','https://github.com'),/minimum launcher/);
 assert.equal(await runtimeSaveSchema(root),23);await verifyRuntime(root,'linux-x64',m);
 await assert.rejects(verifyRuntime(root,'linux-x64',{...m,save:{cli:1,read:[21,22],write:22,startupBackup:1}}),/Signed save schema differs/);
 for(const save of [{cli:1,read:[23],write:23,startupBackup:1},{cli:1,read:[21,22,23,24],write:24,startupBackup:1}]){const bad=signed({...m,save},keys);assert.throws(()=>verifyManifest(bad.bytes,bad.signature,key,m.releaseId,m.tag,'linux-x64','0.1.1','https://github.com'),/compatibility/);}
});
test('runtime compatibility minimum is independent of the publishing launcher version',async()=>{
 const {pins}=await unitRuntime(await directory('minimum-launcher')),legacy={cli:1,read:[21,22],write:22,startupBackup:1};assert.equal(minimumRuntimeLauncher(legacy,pins),'0.1.0');pins.server.commitCount=10;assert.equal(minimumRuntimeLauncher(legacy,pins),'0.1.1');assert.equal(minimumRuntimeLauncher({...legacy,read:[21,22,23],write:23},pins),'0.1.1');assert.throws(()=>minimumRuntimeLauncher({...legacy,read:[21,22,23,24],write:24},pins),/Unsupported save compatibility/);
});
test('native startup acknowledgement is bound to the selected target schema, not merely any supported schema',()=>{
 const ack={protocol:1,operation:'pre-migration',process:42,backup:'/owned/backup.sqlite',sha256:'a'.repeat(64),source_schema:22,target_schema:23,outcome:'verified-backup'};
 assert.equal(nativeAck(ack,ack.backup,42,23).source_schema,22);assert.throws(()=>nativeAck(ack,ack.backup,42,22),/mismatch/);
 assert.throws(()=>nativeAck({...ack,source_schema:24},ack.backup,42,23),/acknowledgement/);
 assert.equal(snapshotPreview({verified:true,schema:23,scope:'all-local-accounts',account_count:1,character_count:2}).schema,23);
 assert.throws(()=>snapshotPreview({verified:true,schema:24,scope:'all-local-accounts',account_count:1,character_count:2}),/snapshot metadata/);
});
