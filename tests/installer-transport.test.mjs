import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,copyFile,open,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {prepareInstallerInputs,requireInstallerArtifact} from '../scripts/installer-inputs.mjs';
import {MANIFEST_PUBLIC_KEY} from '../dist/update-policy.js';
import {hashFile,REPOSITORY,verifyManifest} from '../dist/update-format.js';

const fixtures=resolve('tests/fixtures/installer-transport'),json=async path=>JSON.parse(await readFile(path,'utf8'));
const nativeHead='16ec1744e1d0cbc6a43960b968a3a7b55a1724a6',promotionHead='8873130b08836ef12a517e6f7e4edb461e15496e',nativeRun=42068062946,promotionRun=42086237382;
const binding={installerSourceHead:'d'.repeat(40),runtimeHead:nativeHead,runtimeNativeRun:String(nativeRun),runtimePromotedRun:String(promotionRun),tag:'v0.1.0'};
const run=(id,head,path)=>({id,head_sha:head,head_branch:'main',event:'workflow_dispatch',path,status:'completed',conclusion:'success',repository:{id:1443150754,full_name:REPOSITORY},head_repository:{id:1443150754,full_name:REPOSITORY}});
const native=run(nativeRun,nativeHead,'.github/workflows/runtime-updates-test.yml'),promotion=run(promotionRun,promotionHead,'.github/workflows/promote-runtime.yml');
function artifact(run,name,id){return {id,name,expired:false,expires_at:'2099-01-01T00:00:00Z',url:`https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${id}`,archive_download_url:`https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${id}/zip`,workflow_run:{id:run.id,head_sha:run.head_sha,head_branch:'main',repository_id:run.repository.id,head_repository_id:run.head_repository.id}};}
const nativeArtifact=()=>artifact(native,'runtime-update-ubuntu-22.04',13436636279),list=artifact=>({total_count:1,artifacts:[artifact]});
async function model({receipt=()=>{},after=()=>{},before=()=>{},mode='short',archive,signature='valid',releaseEndpoint}={}){
 await mkdir('.qa/unit',{recursive:true});const root=await mkdtemp(resolve('.qa/unit/installer-transport-')),requests=[],downloads=[];
 const data={validated:await json(join(fixtures,'validated.json')),draft:await json(join(fixtures,'draft.json'))};receipt(data);
 const original=nativeArtifact();before(original);let nativeDownloaded=false;
 const api=async path=>{
  requests.push(path);
  if(path.startsWith('releases/')){assert(releaseEndpoint,'Release endpoint must never be invoked');const response=await fetch(releaseEndpoint);throw Error('Unexpected release lookup HTTP '+response.status);}
  if(path===`actions/runs/${nativeRun}`)return structuredClone(native);
  if(path===`actions/runs/${promotionRun}`)return structuredClone(promotion);
  if(path===`actions/runs/${promotionRun}/artifacts?per_page=100`)return list(artifact(promotion,'runtime-draft-receipts',9001));
  assert.equal(path,`actions/runs/${nativeRun}/artifacts?per_page=100`);const value=structuredClone(original);if(nativeDownloaded)after(value);return list(value);
 };
 const download=async(id,name,destination)=>{
  downloads.push({id,name});
  if(id===String(promotionRun)){
   assert.equal(name,'runtime-draft-receipts');await mkdir(join(destination,'validated'),{recursive:true});await mkdir(join(destination,'signed'));
   await writeFile(join(destination,'validated/validated.json'),JSON.stringify(data.validated));await writeFile(join(destination,'draft.json'),JSON.stringify(data.draft));
   await copyFile(join(fixtures,'runtime-linux-x64.json'),join(destination,'signed/runtime-linux-x64.json'));
   if(signature!=='missing'){const bytes=await readFile(join(fixtures,'runtime-linux-x64.json.sig'));if(signature==='corrupt')bytes[0]^=1;await writeFile(join(destination,'signed/runtime-linux-x64.json.sig'),bytes);}return;
  }
  assert.equal(id,String(nativeRun));assert.equal(name,'runtime-update-ubuntu-22.04');nativeDownloaded=true;
  const directory=join(destination,mode==='wrong-path'?'runtime-inputs/A':'runtime-inputs/C');await mkdir(directory,{recursive:true});const file=join(directory,'runtime-linux-x64.tar.gz');
  if(archive)await copyFile(archive,file);else if(mode==='wrong-hash'){const fd=await open(file,'wx');try{await fd.truncate(50675204);}finally{await fd.close();}}else await writeFile(file,'negative unit bytes, not a runtime archive');
 };
 return {root,requests,downloads,prepare:()=>prepareInstallerInputs(binding,{root,target:'linux-x64',launcher:'0.1.0',pins:JSON.parse(readPins),api,download})};
}
const readPins=JSON.stringify(verifyManifest(await readFile(join(fixtures,'runtime-linux-x64.json')),await readFile(join(fixtures,'runtime-linux-x64.json.sig')),MANIFEST_PUBLIC_KEY,435513734,'v0.1.0','linux-x64','0.1.0','https://github.com').pins);

test('installer transport public fixture is the original production exact-byte signed baseline, without any test signing key',async()=>{
 const value=verifyManifest(await readFile(join(fixtures,'runtime-linux-x64.json')),await readFile(join(fixtures,'runtime-linux-x64.json.sig')),MANIFEST_PUBLIC_KEY,435513734,'v0.1.0','linux-x64','0.1.0','https://github.com');
 assert.equal(value.sequence,1);assert.equal(value.payload.id,714228326);assert.equal(value.payload.sha256,'47494f3f82d8e3173ade702e5774f047e5a2bf4d15b3304fd820231013b2c47d');assert.deepEqual(value.pins,JSON.parse(readPins));assert.equal(value.pins.server.commit,'2c700135d755a4210c2204334aafee2572205ec1');assert.equal(value.pins.client.commit,'d3016983e6fa807be8bf700001e0ba2cf0fc2a7e');
});
test('installer authentic fixture bytes survive actual Git LF/CRLF checkout filters without normalizing signed metadata',async()=>{
 const signature=await readFile(join(fixtures,'runtime-linux-x64.json.sig'));
 for(const [autocrlf,eol] of [['false','lf'],['true','crlf']])for(const name of ['draft.json','validated.json','runtime-linux-x64.json','runtime-linux-x64.json.sig']){
  const path='tests/fixtures/installer-transport/'+name,raw=execFileSync('git',['show','HEAD:'+path]),filtered=execFileSync('git',['-c','core.autocrlf='+autocrlf,'-c','core.eol='+eol,'cat-file','--filters','--path='+path,'HEAD:'+path]);
  assert.deepEqual(filtered,raw,`${path}: autocrlf=${autocrlf}, eol=${eol}`);assert.deepEqual(await readFile(join(fixtures,name)),raw);
  if(name==='runtime-linux-x64.json')verifyManifest(filtered,signature,MANIFEST_PUBLIC_KEY,435513734,'v0.1.0','linux-x64','0.1.0','https://github.com');
 }
 const manifest=await readFile(join(fixtures,'runtime-linux-x64.json')),altered=Buffer.from(manifest.toString('utf8').replaceAll('\n','\r\n'));assert.notDeepEqual(altered,manifest);
 assert.throws(()=>verifyManifest(altered,signature,MANIFEST_PUBLIC_KEY,435513734,'v0.1.0','linux-x64','0.1.0','https://github.com'),/signature/);
});
test('installer native Actions identity rejects missing, duplicate, wrong ID/name/run/head/repository, incomplete and expired input',()=>{
 const changes=[x=>x.artifacts=[],x=>x.artifacts.push(x.artifacts[0]),x=>x.total_count=1000,x=>x.artifacts[0].id=0,x=>x.artifacts[0].name='other',x=>x.artifacts[0].expired=true,x=>x.artifacts[0].expires_at='2000-01-01T00:00:00Z',x=>x.artifacts[0].workflow_run.id=1,x=>x.artifacts[0].workflow_run.head_sha=promotionHead,x=>x.artifacts[0].workflow_run.head_branch='candidate',x=>x.artifacts[0].workflow_run.repository_id=1,x=>x.artifacts[0].workflow_run.head_repository_id=1,x=>x.artifacts[0].url+='wrong'];
 for(const change of changes){const value=list(nativeArtifact());change(value);assert.throws(()=>requireInstallerArtifact(value,native,'runtime-update-ubuntu-22.04'));}
 assert.equal(requireInstallerArtifact(list(nativeArtifact()),native,'runtime-update-ubuntu-22.04').id,13436636279);
});
test('installer transport rejects protected receipt/signature/pin/path substitutions before downloading native bytes',async()=>{
 const changes=[x=>x.validated.head=promotionHead,x=>x.validated.promotionHead=nativeHead,x=>x.validated.runId=1,x=>x.validated.sequence=2,x=>x.draft.id++,x=>x.draft.target_commitish=promotionHead,x=>x.draft.assets.find(a=>a.name==='runtime-linux-x64.tar.gz').id++,x=>x.validated.targets[0].payload.identitySha256='0'.repeat(64),x=>x.validated.targets[0].payload.binarySha256='0'.repeat(64),x=>x.validated.targets[0].payload.assetsSha256='0'.repeat(64),x=>x.validated.targets[0].pins.server.commit='0'.repeat(40),x=>x.validated.targets[0].archive=x.validated.targets[0].archive.replace('runtime-inputs/C/','runtime-inputs/A/')];
 for(const receipt of changes){const m=await model({receipt});await assert.rejects(m.prepare());assert.equal(m.downloads.length,1,'Invalid protected metadata must fail before native download');}
 for(const signature of ['corrupt','missing']){const m=await model({signature});await assert.rejects(m.prepare(),signature==='corrupt'?/signature/:/ENOENT/);assert.equal(m.downloads.length,1);}
});
test('installer transport rejects native artifact replacement/expiry during download, wrong archive path, length and actual byte hash',async()=>{
 const replaced=await model({after:x=>{x.id++;x.url=`https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${x.id}`;x.archive_download_url=x.url+'/zip';}});await assert.rejects(replaced.prepare(),/identity changed/);
 const expired=await model({after:x=>x.expired=true});await assert.rejects(expired.prepare(),/expired/);
 for(const [mode,error] of [['wrong-path',/ENOENT/],['short',/byte length mismatch/],['wrong-hash',/digest mismatch/]]){const m=await model({mode});await assert.rejects(m.prepare(),error);}
});
test('installer transport never invokes the controlled forbidden draft403 endpoint, even when native input fails',async()=>{
 let calls=0;const server=createServer((_request,response)=>{calls++;response.writeHead(403);response.end('Resource not accessible by integration');});await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
 try{const m=await model({releaseEndpoint:`http://127.0.0.1:${server.address().port}/releases/435513734`});await assert.rejects(m.prepare(),/byte length mismatch/);assert.equal(calls,0);assert(m.requests.every(path=>path.startsWith('actions/')));}finally{await new Promise(ok=>server.close(ok));}
});
test('installer transport positive exact native archive bytes + production signed baseline (explicit local read-only original archive)',{skip:!process.env.OPENROTMG_INSTALLER_TRANSPORT_ARCHIVE},async()=>{
 let calls=0;const server=createServer((_request,response)=>{calls++;response.writeHead(403);response.end();});await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
 try{
  const m=await model({archive:process.env.OPENROTMG_INSTALLER_TRANSPORT_ARCHIVE,releaseEndpoint:`http://127.0.0.1:${server.address().port}/releases/435513734`}),{inputs,attribution}=await m.prepare(),input=await json(inputs);
  assert.equal(attribution.runtimeArchive.assetId,714228326);assert.equal(attribution.runtimeArchive.actionsInput.artifactId,13436636279);assert.equal(attribution.runtimeArchive.actionsInput.runId,nativeRun);assert.equal(attribution.runtimeArchive.actionsInput.sourceHead,nativeHead);assert.equal(attribution.runtimePromotionHead,promotionHead);assert.notEqual(attribution.installerSourceHead,promotionHead);
  assert.equal(input.runtimeRelease.archive,join(m.root,'native/runtime-inputs/C/runtime-linux-x64.tar.gz'));assert.equal((await stat(input.runtimeRelease.archive)).size,50675204);assert.equal(await hashFile(input.runtimeRelease.archive),attribution.runtimeArchive.sha256);
  assert.deepEqual(await readFile(input.runtimeRelease.manifest),await readFile(join(fixtures,'runtime-linux-x64.json')));assert.deepEqual(await readFile(input.runtimeRelease.signature),await readFile(join(fixtures,'runtime-linux-x64.json.sig')));
  assert(attribution.releaseSnapshot.includes('historical'));assert(!JSON.stringify(attribution).includes('zipSha256'));assert.equal(calls,0);assert(m.requests.every(path=>path.startsWith('actions/')));
 }finally{await new Promise(ok=>server.close(ok));}
});
