import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,copyFile,readdir,lstat} from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {boundedFile,hashFile,REPOSITORY,targetName,verifyManifest} from '../dist/update-format.js';
import {MANIFEST_PUBLIC_KEY} from '../dist/update-policy.js';
import {requireReleaseAssetMetadata} from './runtime-release-history.mjs';

export function installerBindings(env,head){
 const {INSTALLER_SHA:installerSourceHead,RUNTIME_HEAD:runtimeHead,RUNTIME_NATIVE_RUN:runtimeNativeRun,RUNTIME_PROMOTION_RUN:runtimePromotedRun,RELEASE_TAG:tag}=env;
 for(const sha of [installerSourceHead,runtimeHead])assert(/^[a-f0-9]{40}$/.test(sha),'Exact full Git SHA required');
 for(const run of [runtimeNativeRun,runtimePromotedRun])assert(/^[1-9][0-9]*$/.test(run),'Exact numeric workflow run required');
 assert(/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag),'Explicit immutable release tag required');
 assert.equal(installerSourceHead,head,'Dispatch ref must resolve to the requested installer SHA');
 return {installerSourceHead,runtimeHead,runtimeNativeRun,runtimePromotedRun,tag};
}
export function validateInstallerPromotion(binding,{promotion,native,validated,draft},target){
 assert(/^[a-f0-9]{40}$/.test(validated.promotionHead),'Exact protected promotion-controller SHA required');
 for(const [run,id,path] of [[promotion,binding.runtimePromotedRun,'.github/workflows/promote-runtime.yml'],[native,binding.runtimeNativeRun,'.github/workflows/runtime-updates-test.yml']]){
  assert.equal(String(run.id),id);assert.equal(run.head_sha,run===promotion?validated.promotionHead:binding.runtimeHead);assert.equal(run.head_branch,'main');assert.equal(run.event,'workflow_dispatch');assert.equal(run.path,path);assert.equal(run.status,'completed');assert.equal(run.conclusion,'success');assert.equal(run.repository.full_name,REPOSITORY);assert.equal(run.head_repository.full_name,REPOSITORY);
 }
 assert.equal(validated.head,binding.runtimeHead);assert.equal(String(validated.runId),binding.runtimeNativeRun);assert.equal(validated.tag,binding.tag);
 assert(draft&&Number.isSafeInteger(draft.id)&&draft.id>0,'Protected promotion must retain its exact draft ID');assert.equal(draft.draft,true);assert.equal(draft.tag_name,binding.tag);assert.equal(draft.target_commitish,binding.runtimeHead);
 assert(Number.isSafeInteger(validated.sequence)&&validated.sequence>0);
 assert.equal(validated.targets.filter(entry=>entry.target===target).length,1,'Exactly one promoted native target required');
 const entry=validated.targets.find(entry=>entry.target===target),name=`runtime-${target}.tar.gz`,assets=draft.assets.filter(asset=>asset.name===name);assert.equal(assets.length,1,'Exactly one original archive asset required in protected draft snapshot');
 const archiveAsset=assets[0];requireReleaseAssetMetadata(draft,archiveAsset,binding.tag);assert.equal(archiveAsset.size,entry.payload.bytes);assert.equal(archiveAsset.digest,'sha256:'+entry.payload.sha256);
 return {entry,archiveAsset};
}
export function requireInstallerArtifact(list,run,name){
 assert(Number.isSafeInteger(run.id)&&run.id>0,'Positive provider run ID required');
 assert.equal(list.total_count,list.artifacts.length,'Artifact listing must be complete');
 const matches=list.artifacts.filter(artifact=>artifact.name===name);assert.equal(matches.length,1,'Exactly one original Actions artifact required: '+name);
 const artifact=matches[0];assert(Number.isSafeInteger(artifact.id)&&artifact.id>0,'Positive Actions artifact ID required');assert.equal(artifact.expired,false,'Actions artifact expired');assert(Date.parse(artifact.expires_at)>Date.now(),'Actions artifact expiry reached');
 assert(Number.isSafeInteger(run.repository.id)&&run.repository.id>0&&Number.isSafeInteger(run.head_repository.id)&&run.head_repository.id>0,'Provider repository IDs required');
 assert.equal(artifact.workflow_run.id,run.id);assert.equal(artifact.workflow_run.head_sha,run.head_sha);assert.equal(artifact.workflow_run.head_branch,'main');assert.equal(artifact.workflow_run.repository_id,run.repository.id);assert.equal(artifact.workflow_run.head_repository_id,run.head_repository.id);
 assert.equal(artifact.url,`https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${artifact.id}`);assert.equal(artifact.archive_download_url,artifact.url+'/zip');
 return artifact;
}
async function downloadInstallerArtifact(api,download,run,name,destination){
 const endpoint=`actions/runs/${run.id}/artifacts?per_page=100`,before=requireInstallerArtifact(await api(endpoint),run,name);
 await download(String(run.id),name,destination);
 const after=requireInstallerArtifact(await api(endpoint),run,name);assert.deepEqual(after,before,'Actions artifact identity changed during download');
 return before;
}
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const gh=(...args)=>execFileSync('gh',args,{maxBuffer:4*1024*1024});
const json=async path=>JSON.parse(await readFile(path,'utf8'));
export async function prepareInstallerInputs(binding,{root,target,launcher,pins,api,download}){
 const promotion=await api(`actions/runs/${binding.runtimePromotedRun}`),native=await api(`actions/runs/${binding.runtimeNativeRun}`);
 // Authenticate the historical signing checkpoint, never query a draft endpoint with the read-only installer token.
 const promotionArtifact=await downloadInstallerArtifact(api,download,promotion,'runtime-draft-receipts',join(root,'promotion'));
 const validated=await json(join(root,'promotion/validated/validated.json')),draft=await json(join(root,'promotion/draft.json'));
 const {entry,archiveAsset}=validateInstallerPromotion(binding,{promotion,native,validated,draft},target);
 const name=`runtime-${target}.json`,signed=join(root,'promotion/signed',name),rawSignature=signed+'.sig';
 const value=verifyManifest(await boundedFile(signed,64*1024),await boundedFile(rawSignature,64),MANIFEST_PUBLIC_KEY,draft.id,binding.tag,target,launcher,'https://github.com');
 assert.equal(value.version,binding.tag.slice(1));assert.equal(value.sequence,validated.sequence);assert.deepEqual(value.pins,pins);assert.deepEqual(value.pins,entry.pins);assert.equal(value.payload.id,archiveAsset.id);assert.equal(value.payload.bytes,archiveAsset.size);assert.equal(archiveAsset.digest,'sha256:'+value.payload.sha256);assert.equal(entry.startupBackup,1);assert.equal(entry.clientNamespace,1);
 for(const key of ['name','sha256','bytes','expandedBytes','identitySha256','binarySha256','assetsSha256'])assert.equal(value.payload[key],entry.payload[key],'Signed archive differs from tested promoted archive: '+key);
 const os={'linux-x64':'ubuntu-22.04','win32-x64':'windows-2022','darwin-arm64':'macos-15'}[target],artifactName=`runtime-update-${os}`,path=`runtime-inputs/C/${value.payload.name}`;
 assert(entry.archive.endsWith('/'+artifactName+'/'+path),'Promoted native archive path differs from exact C payload path');
 const nativeRoot=join(root,'native'),nativeArtifact=await downloadInstallerArtifact(api,download,native,artifactName,nativeRoot),archive=join(nativeRoot,...path.split('/'));
 for(const part of [nativeRoot,join(nativeRoot,'runtime-inputs'),join(nativeRoot,'runtime-inputs/C'),archive])assert(!(await lstat(part)).isSymbolicLink(),'Native archive path must not traverse a symlink');
 const info=await lstat(archive);assert(info.isFile(),'Native runtime archive must be a regular file');assert.equal(info.size,value.payload.bytes,'Native runtime archive byte length mismatch');assert.equal(await hashFile(archive),value.payload.sha256,'Native runtime archive digest mismatch');
 const manifest=join(root,name),signature=manifest+'.sig';await copyFile(signed,manifest);await copyFile(rawSignature,signature);
 const inputs=join(root,'build-inputs.json');await writeFile(inputs,JSON.stringify({runtimeRelease:{manifest,signature,archive}},null,2)+'\n',{flag:'wx'});
 const actionsInput={artifactId:nativeArtifact.id,artifactName:nativeArtifact.name,runId:native.id,sourceHead:native.head_sha,path,sha256:value.payload.sha256,bytes:info.size};
 const attribution={...binding,runtimePromotionHead:validated.promotionHead,promotionArtifactId:promotionArtifact.id,target,releaseId:draft.id,releaseSnapshot:'historical protected promotion artifact; no live draft lookup',sequence:value.sequence,runtimeArchive:{name:archiveAsset.name,assetId:archiveAsset.id,sha256:value.payload.sha256,bytes:value.payload.bytes,actionsInput},pins:value.pins};
 await writeFile(join(root,'attribution.json'),JSON.stringify(attribution,null,2)+'\n',{flag:'wx'});return {inputs,attribution};
}
export async function prepareInstaller(){
 assert.equal(process.env.GITHUB_ACTIONS,'true','Protected artifact consumption requires the owned hosted workflow');
 const binding=installerBindings(process.env,git('rev-parse','HEAD'));assert.equal(process.env.GITHUB_SHA,binding.installerSourceHead);
 assert.equal(git('status','--porcelain','--untracked-files=no'),'','Installer source must be clean');
 const root=resolve('.qa/installer-inputs');await mkdir('.qa',{recursive:true});await mkdir(root);
 const api=path=>JSON.parse(gh('api',`repos/${REPOSITORY}/${path}`)),download=(run,name,destination)=>gh('run','download',run,'--repo',REPOSITORY,'--name',name,'--dir',destination);
 const {inputs}=await prepareInstallerInputs(binding,{root,target:targetName(),launcher:(await json('package.json')).version,pins:await json('source-pins.json'),api,download});
 await writeFile(process.env.GITHUB_ENV,`OPENROTMG_BUILD_INPUTS=${inputs}\n`,{flag:'a'});
}
async function collectInstaller(){
 const attribution=await json('.qa/installer-inputs/attribution.json');assert.equal(attribution.installerSourceHead,git('rev-parse','HEAD'));assert.equal(git('status','--porcelain','--untracked-files=no'),'');
 const output=resolve('.qa/installer-delivery');await mkdir(output);
 async function walk(root){const paths=[];for(const entry of await readdir(root,{withFileTypes:true})){const path=join(root,entry.name);if(entry.isDirectory())paths.push(...await walk(path));else if(entry.isFile())paths.push(path);}return paths;}
 const installers=(await walk('out/make')).filter(path=>path.endsWith('.zip'));assert.equal(installers.length,1,'Exactly one portable ZIP required');
 const name=`openrotmg-singleplayer-${(await json('package.json')).version}-${attribution.target}.zip`;await copyFile(installers[0],join(output,name));
 execFileSync('git',['archive','--format=tar.gz',`--output=${join(output,'launcher-source.tar.gz')}`,attribution.installerSourceHead]);
 for(const suffix of ['json','tar.gz'])await copyFile(`out/make/launcher-${attribution.target}.${suffix}`,join(output,`launcher-${attribution.target}.${suffix}`));
 const sources=[];
 for(const kind of ['server','client']){
  const pin=attribution.pins[kind],repository=pin.repository.replace('https://github.com/',''),file=`${kind}-source-${pin.commit}.tar.gz`,fd=openSync(join(output,file),'wx');
  try{execFileSync('gh',['api',`repos/${repository}/tarball/${pin.commit}`],{stdio:['ignore',fd,'inherit']});}finally{closeSync(fd);}
  sources.push({kind,repository,commit:pin.commit,archive:file,sha256:await hashFile(join(output,file))});
 }
 for(const file of ['LICENSE','NOTICES.md','source-pins.json'])await copyFile(file,join(output,file));
 for(const suffix of ['.json','.json.sig'])await copyFile(`.qa/installer-inputs/runtime-${attribution.target}${suffix}`,join(output,`runtime-${attribution.target}${suffix}`));
 const receipt={format:1,...attribution,installer:{name,sha256:await hashFile(join(output,name)),osSignature:'UNSIGNED; no Authenticode signing or Apple notarization performed'},sources,qualification:'Pending installer-result.json from native installed/extracted application; not publication approval'};
 await writeFile(join(output,'installer-receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
 const checksums=[];for(const file of (await readdir(output)).sort())checksums.push(`${await hashFile(join(output,file))}  ${file}`);await writeFile(join(output,'SHA256SUMS'),checksums.join('\n')+'\n',{flag:'wx'});
 console.log(join(output,name));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 assert(['prepare','collect','check'].includes(process.argv[2]),'Use installer-inputs.mjs prepare|collect|check');
 if(process.argv[2]==='prepare')await prepareInstaller();else if(process.argv[2]==='collect')await collectInstaller();else{
  const baseline=await json('dist/runtime-baseline.json');assert.equal(baseline.mode,'release','Installer makers require an authenticated promoted release baseline, never a source preview');
  verifyManifest(Buffer.from(baseline.manifest,'base64'),Buffer.from(baseline.signature,'base64'),MANIFEST_PUBLIC_KEY,undefined,undefined,targetName(),(await json('package.json')).version,'https://github.com');
 }
}
