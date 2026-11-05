import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,copyFile,readdir,stat} from 'node:fs/promises';
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
export function validateInstallerPromotion(binding,{promotion,native,validated,draft,release},target){
 assert(/^[a-f0-9]{40}$/.test(validated.promotionHead),'Exact protected promotion-controller SHA required');
 for(const [run,id,path] of [[promotion,binding.runtimePromotedRun,'.github/workflows/promote-runtime.yml'],[native,binding.runtimeNativeRun,'.github/workflows/runtime-updates-test.yml']]){
  assert.equal(String(run.id),id);assert.equal(run.head_sha,run===promotion?validated.promotionHead:binding.runtimeHead);assert.equal(run.head_branch,'main');assert.equal(run.event,'workflow_dispatch');assert.equal(run.path,path);assert.equal(run.conclusion,'success');assert.equal(run.head_repository.full_name,REPOSITORY);
 }
 assert.equal(validated.head,binding.runtimeHead);assert.equal(String(validated.runId),binding.runtimeNativeRun);assert.equal(validated.tag,binding.tag);
 assert(draft&&Number.isSafeInteger(draft.id)&&draft.id>0,'Protected promotion must retain its exact draft ID');assert.equal(draft.draft,true);assert.equal(draft.tag_name,binding.tag);assert.equal(draft.target_commitish,binding.runtimeHead);
 assert.equal(release.id,draft.id);assert.equal(release.tag_name,binding.tag);assert.equal(release.target_commitish,binding.runtimeHead);
 assert(Number.isSafeInteger(validated.sequence)&&validated.sequence>0);
 assert.equal(validated.targets.filter(entry=>entry.target===target).length,1,'Exactly one promoted native target required');
 const entry=validated.targets.find(entry=>entry.target===target);
 const assets=['.json','.json.sig','.tar.gz'].map(suffix=>{
  const name=`runtime-${target}${suffix}`,matches=release.assets.filter(asset=>asset.name===name);assert.equal(matches.length,1,'Exactly one immutable release asset required: '+name);
  const asset=matches[0];requireReleaseAssetMetadata(release,asset,binding.tag);
  if(suffix==='.tar.gz'){const original=draft.assets.filter(a=>a.name===name);assert.equal(original.length,1);assert.equal(asset.id,original[0].id,'Native archive asset was replaced after protected promotion');assert.equal(asset.size,original[0].size);}
  return asset;
 });
 return {entry,assets};
}
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const gh=(...args)=>execFileSync('gh',args,{maxBuffer:4*1024*1024});
const json=async path=>JSON.parse(await readFile(path,'utf8'));
export async function prepareInstaller(){
 assert.equal(process.env.GITHUB_ACTIONS,'true','Protected draft consumption requires the owned hosted workflow');
 const binding=installerBindings(process.env,git('rev-parse','HEAD'));assert.equal(process.env.GITHUB_SHA,binding.installerSourceHead);
 assert.equal(git('status','--porcelain','--untracked-files=no'),'','Installer source must be clean');
 const root=resolve('.qa/installer-inputs');await mkdir('.qa',{recursive:true});await mkdir(root);
 const api=path=>JSON.parse(gh('api',`repos/${REPOSITORY}/${path}`));
 const promotion=api(`actions/runs/${binding.runtimePromotedRun}`),native=api(`actions/runs/${binding.runtimeNativeRun}`);
 gh('run','download',binding.runtimePromotedRun,'--repo',REPOSITORY,'--name','runtime-draft-receipts','--dir',join(root,'promotion'));
 const validated=await json(join(root,'promotion/validated/validated.json')),draft=await json(join(root,'promotion/draft.json')),target=targetName();
 assert(Number.isSafeInteger(draft.id)&&draft.id>0,'Protected promotion must retain its exact draft ID');
 const release=api(`releases/${draft.id}`);
 const {entry,assets}=validateInstallerPromotion(binding,{promotion,native,validated,draft,release},target);
 for(const asset of assets){const path=join(root,asset.name),fd=openSync(path,'wx');try{execFileSync('gh',['api',`repos/${REPOSITORY}/releases/assets/${asset.id}`,'-H','Accept: application/octet-stream'],{stdio:['ignore',fd,'inherit']});}finally{closeSync(fd);}assert.equal((await stat(path)).size,asset.size,'Downloaded exact asset size mismatch');}
 const [manifestAsset,signatureAsset,archiveAsset]=assets,manifest=join(root,manifestAsset.name),signature=join(root,signatureAsset.name),archive=join(root,archiveAsset.name);
 const value=verifyManifest(await boundedFile(manifest,64*1024),await boundedFile(signature,64),MANIFEST_PUBLIC_KEY,release.id,binding.tag,target,(await json('package.json')).version,'https://github.com');
 assert.equal(value.sequence,validated.sequence);assert.deepEqual(value.pins,await json('source-pins.json'));assert.deepEqual(value.pins,entry.pins);assert.equal(value.payload.id,archiveAsset.id);assert.equal(value.payload.bytes,archiveAsset.size);
 for(const key of ['sha256','bytes','expandedBytes','identitySha256','binarySha256','assetsSha256'])assert.equal(value.payload[key],entry.payload[key],'Signed archive differs from tested promoted archive: '+key);
 assert.equal(await hashFile(archive),value.payload.sha256);
 const inputs=join(root,'build-inputs.json');await writeFile(inputs,JSON.stringify({runtimeRelease:{manifest,signature,archive}},null,2)+'\n',{flag:'wx'});
 await writeFile(join(root,'attribution.json'),JSON.stringify({...binding,runtimePromotionHead:validated.promotionHead,target,releaseId:release.id,sequence:value.sequence,runtimeArchive:{name:archiveAsset.name,assetId:archiveAsset.id,sha256:value.payload.sha256,bytes:value.payload.bytes},pins:value.pins},null,2)+'\n',{flag:'wx'});
 await writeFile(process.env.GITHUB_ENV,`OPENROTMG_BUILD_INPUTS=${inputs}\n`,{flag:'a'});
}
async function collectInstaller(){
 const attribution=await json('.qa/installer-inputs/attribution.json');assert.equal(attribution.installerSourceHead,git('rev-parse','HEAD'));assert.equal(git('status','--porcelain','--untracked-files=no'),'');
 const output=resolve('.qa/installer-delivery');await mkdir(output);
 async function walk(root){const paths=[];for(const entry of await readdir(root,{withFileTypes:true})){const path=join(root,entry.name);if(entry.isDirectory())paths.push(...await walk(path));else if(entry.isFile())paths.push(path);}return paths;}
 const extension={ 'linux-x64':'.zip','win32-x64':'.msi','darwin-arm64':'.dmg'}[attribution.target];assert(extension);
 const installers=(await walk('out/make')).filter(path=>path.endsWith(extension));assert.equal(installers.length,1,'Exactly one native Forge installer/archive required');
 const name=`openrotmg-${(await json('package.json')).version}-${attribution.target}${extension}`;await copyFile(installers[0],join(output,name));
 execFileSync('git',['archive','--format=tar.gz',`--output=${join(output,'launcher-source.tar.gz')}`,attribution.installerSourceHead]);
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
