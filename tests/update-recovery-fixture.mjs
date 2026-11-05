import {mkdir,readFile,writeFile,cp} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {RuntimeStore,durableBytes,generation,select} from '../dist/update-store.js';
import {RecoveredRuntimeFence} from '../dist/update-recovery.js';
import {digest} from '../dist/update-format.js';
import {backupPath} from '../dist/update-journal.js';
import {directory,unitRuntime,keyPair,publicPEM,manifestFor,signed} from './update-fixture.mjs';

// Synthetic crash-fence records only: no real Rust, migration, process-close or packaged-game qualification.
export async function recovered(){
 const root=await directory('update-recovery'),bundle=join(root,'bundle'),user=join(root,'user');await unitRuntime(bundle,{legacy:true});await mkdir(user);const keys=keyPair();
 const policy={target:'linux-x64',launcher:'0.1.0',baseline:{root:bundle,mode:'source',startupBackup:0,clientNamespace:0,identitySha256:digest(await readFile(join(bundle,'build-identity.json')))},publicKey:publicPEM(keys),assetOrigin:'https://github.com',discovery:'https://api.github.com/repos/OpenRotMG/Open-RotMG-Single-Player/releases/latest',redirectOrigins:['https://api.github.com','https://github.com'],request:async()=>new Response('synthetic unit service unavailable',{status:503}),metadataDeadline:200,payloadDeadline:200};
 const store=new RuntimeStore(user,policy),a=(await store.initialize()).selected;
 const bRoot=join(root,'candidate');await unitRuntime(bRoot,{serverCommit:'8'.repeat(40),clientCommit:'9'.repeat(40)});const m=await manifestFor(bRoot,join(root,'candidate.tar.gz'),'https://github.com',2),s=signed(m,keys),stage=await store.stage();await cp(bRoot,join(stage,'runtime'),{recursive:true});await durableBytes(join(stage,'manifest.json'),s.bytes);await durableBytes(join(stage,'manifest.sig'),s.signature);
 const identity=JSON.parse(await readFile(join(bRoot,'build-identity.json'),'utf8')),b=generation(identity,digest(await readFile(join(bRoot,'build-identity.json'))),'linux-x64',1,1,m,digest(s.bytes));await store.publish(stage,b);
 const marker=Buffer.from('{"error":"synthetic failed candidate; no native command executed"}\n');await writeFile(join(user,'shutdown-failed.json'),marker);const markerSha=digest(marker),id=randomUUID(),metadata={verified:true,schema:22,scope:'all-local-accounts',account_count:1,character_count:1};
 const input={name:'fresh-native-unit.sqlite',sha256:'a'.repeat(64),metadata,authority:select(b)},pre={name:'pre-restore-unit.sqlite',sha256:'b'.repeat(64),metadata,authority:select(b)};
 const p={format:1,id,kind:'update',phase:'starting',from:select(a),to:select(b),preBackup:null,noDatabase:false,migrationName:input.name,pid:123,nativeAck:{protocol:1,operation:'pre-migration',process:123,backup:backupPath(store,input.name),sha256:input.sha256,source_schema:22,target_schema:22,outcome:'verified-backup'},readiness:null,failureSha256:markerSha,recovery:null};
 const receipt={format:1,id:randomUUID(),kind:'restore',markerSha256:markerSha,previousSha256:null,from:select(b),to:select(a),pendingId:id,fenceId:randomUUID(),proof:{pending:p,input,preRestore:pre,restoreAck:{restored:true,backup:backupPath(store,pre.name)},authority:select(b),close:{code:0,signal:null}}};
 const fence=new RecoveredRuntimeFence(store),intent={format:1,id:randomUUID(),pendingSha256:await fence.remember(p),oldActivitySha256:null,markerSha256:markerSha,previousSha256:null,selected:p.to,prior:p.from,candidate:p.to,backupName:input.name,backupSha256:input.sha256,activityId:receipt.fenceId,target:'linux-x64'};receipt.proof.intentSha256=await fence.remember(intent);const sha=await fence.publish(receipt,'clean');return{root,user,store,policy,a,b,p,receipt,fence,sha,marker};
}

export async function capableRecovered(){
 const f=await recovered(),auth=await f.fence.requireClean(select(f.a)),id=randomUUID(),activity=await f.fence.active('server',select(f.b),id,auth);
 const readiness={pid:123,healthProcess:123,listenerSeen:true,binarySha256:f.b.binarySha256,selected:select(f.b)},p={...f.p,id,phase:'ready',readiness,failureSha256:null};
 const receipt={format:1,id:randomUUID(),kind:'transition',markerSha256:auth.receipt.markerSha256,previousSha256:auth.sha256,from:select(f.a),to:select(f.b),pendingId:id,fenceId:activity.id,proof:{pending:p,nativeAck:p.nativeAck,readiness}};
 await f.store.choose(f.b);const sha=await f.fence.publish(receipt,'active',activity);await f.fence.clean(await f.fence.activity(),{pid:123,code:0,signal:null,closed:true,selected:select(f.b)});
 return{...f,capableSha:sha};
}
