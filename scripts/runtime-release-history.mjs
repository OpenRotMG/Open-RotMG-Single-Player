import assert from 'node:assert/strict';
import {authenticateManifest,REPOSITORY,TARGETS,digest} from '../dist/update-format.js';

export const UNSIGNED_RUNTIME_DRAFT={releaseId:435513734,failedPromotionRun:42075685932,nativeRun:42068062946,head:'16ec1744e1d0cbc6a43960b968a3a7b55a1724a6',tag:'v0.1.0',sequence:1,assets:{
 'darwin-arm64':{id:714228328,bytes:49521827,sha256:'662d20df6d749098564437f760576c46a78630f83de34da803b37c641ab500dc'},
 'linux-x64':{id:714228326,bytes:50675204,sha256:'47494f3f82d8e3173ade702e5774f047e5a2bf4d15b3304fd820231013b2c47d'},
 'win32-x64':{id:714228329,bytes:50035390,sha256:'b8c73976e4544c149e2bef540e36d514145c6f72d471613fe03ce71f2c2ff262'},
}};
export const PROMOTION_CONTROLLER_PATHS=['.github/workflows/promote-runtime.yml','scripts/promote-runtime.mjs','scripts/runtime-release-history.mjs','tests/runtime-update-workflows.test.mjs','tests/runtime-draft-resumption.test.mjs'];
export const runtimeDraftBody=(head,sequence)=>`RUNTIME_SEQUENCE=${sequence}\nCANDIDATE_SHA=${head}\nAuthenticated paired runtime; draft pending parent publication and Phase 6 installer delivery.`;
const positive=value=>Number.isSafeInteger(value)&&value>0;
export function requirePromotionSource(nativeHead,promotionHead,git){
 assert(/^[a-f0-9]{40}$/.test(nativeHead)&&/^[a-f0-9]{40}$/.test(promotionHead));git('merge-base','--is-ancestor',nativeHead,promotionHead);
 const entries=ref=>new Map(git('ls-tree','-rz','--full-tree',ref).toString().split('\0').filter(Boolean).map(line=>{const at=line.indexOf('\t');assert(at>0);return[line.slice(at+1),line.slice(0,at)];})),before=entries(nativeHead),after=entries(promotionHead),changed=[];
 for(const path of new Set([...before.keys(),...after.keys()]))if(before.get(path)!==after.get(path)){assert(PROMOTION_CONTROLLER_PATHS.includes(path),'Non-controller tracked source/mode/type changed: '+path);changed.push(path);}
 return{nativeHead,promotionHead,changed:changed.sort(),unchangedEntries:[...before.keys()].filter(path=>before.get(path)===after.get(path)).length};
}
export function requireNativePromotionRun(run,jobs,head,id){
 assert.equal(run.id,id);assert.equal(run.head_sha,head);assert.equal(run.head_branch,'main');assert.equal(run.event,'workflow_dispatch');assert.equal(run.path,'.github/workflows/runtime-updates-test.yml');assert.equal(run.status,'completed');assert.equal(run.conclusion,'success');assert.equal(run.repository.full_name,REPOSITORY);assert.equal(run.head_repository.full_name,REPOSITORY);assert(positive(run.run_attempt));assert.equal(jobs.total_count,3);assert.equal(jobs.jobs.length,3);
 const mac=jobs.jobs.filter(j=>/^runtime-updates \(macos-(15|26)\)$/.test(j.name));assert.equal(mac.length,1,'Exactly one supported standard Apple Silicon job required');
 for(const name of ['runtime-updates (ubuntu-22.04)','runtime-updates (windows-2022)',mac[0].name]){const found=jobs.jobs.filter(j=>j.name===name);assert.equal(found.length,1);const job=found[0];assert.equal(job.run_id,id);assert.equal(job.head_sha,head);assert.equal(job.head_branch,'main');assert.equal(job.run_attempt,run.run_attempt);assert.equal(job.status,'completed');assert.equal(job.conclusion,'success');}
}
export function requireUnsignedResume(validated,run,jobs){
 const c=UNSIGNED_RUNTIME_DRAFT;assert.deepEqual(validated.resume,{releaseId:c.releaseId,failedPromotionRun:c.failedPromotionRun});assert.equal(validated.head,c.head);assert.equal(validated.runId,c.nativeRun);assert.equal(validated.tag,c.tag);assert.equal(validated.sequence,c.sequence);
 assert.equal(run.id,c.failedPromotionRun);assert.equal(run.run_attempt,1);assert.equal(run.head_sha,c.head);assert.equal(run.head_branch,'main');assert.equal(run.event,'workflow_dispatch');assert.equal(run.path,'.github/workflows/promote-runtime.yml');assert.equal(run.status,'completed');assert.equal(run.conclusion,'failure');assert.equal(run.repository.full_name,REPOSITORY);assert.equal(run.head_repository.full_name,REPOSITORY);
 assert.equal(jobs.total_count,1);assert.equal(jobs.jobs.length,1);const job=jobs.jobs[0];assert.equal(job.run_id,run.id);assert.equal(job.run_attempt,1);assert.equal(job.head_sha,c.head);assert.equal(job.head_branch,'main');assert.equal(job.name,'stage-draft');assert.equal(job.status,'completed');assert.equal(job.conclusion,'failure');
 const step=(name,conclusion)=>{const found=job.steps.filter(s=>s.name===name);assert.equal(found.length,1);assert.equal(found[0].status,'completed');assert.equal(found[0].conclusion,conclusion);return found[0].number;};
 const fetched=step('Fetch exact native run and data-only artifacts','success'),created=step('Create NEW draft and upload exact already-tested payloads without clobber','failure'),signed=step('Sign exact metadata with trusted-main code (only secret-bearing step)','skipped'),uploaded=step('Upload public metadata and raw detached signatures; leave release DRAFT','skipped');assert(fetched<created&&created<signed&&signed<uploaded,'Failed promotion checkpoint order differs');
}
export function requireFirstUnsignedResume(api,currentId,attempt,promotionHead){
 assert(positive(currentId)&&currentId>UNSIGNED_RUNTIME_DRAFT.failedPromotionRun);assert.equal(attempt,1,'Unsigned resume is first-attempt only');let finished=false,total,seen=0,original=0,count=0;
 for(let page=1;page<=100;page++){
  const result=JSON.parse(api(`repos/${REPOSITORY}/actions/workflows/promote-runtime.yml/runs?per_page=100&page=${page}`));assert(Array.isArray(result.workflow_runs));assert(Number.isSafeInteger(result.total_count)&&result.total_count<=10000);if(total===undefined)total=result.total_count;assert.equal(result.total_count,total,'Promotion history changed during review');count+=result.workflow_runs.length;
  for(const run of result.workflow_runs){assert(positive(run.id));assert.equal(run.path,'.github/workflows/promote-runtime.yml');
   if(run.id===currentId){seen++;assert.equal(run.head_sha,promotionHead);assert.equal(run.head_branch,'main');assert.equal(run.event,'workflow_dispatch');assert.equal(run.run_attempt,1);assert.equal(run.status,'in_progress');assert.equal(run.conclusion,null);assert.equal(run.repository.full_name,REPOSITORY);assert.equal(run.head_repository.full_name,REPOSITORY);}
   else assert(run.id<=UNSIGNED_RUNTIME_DRAFT.failedPromotionRun,'A later promotion attempt exists; unsigned resume is no longer authorized');
   if(run.id===UNSIGNED_RUNTIME_DRAFT.failedPromotionRun){original++;assert.equal(run.head_sha,UNSIGNED_RUNTIME_DRAFT.head);}
  }
  if(result.workflow_runs.length<100){finished=true;break;}
 }
 assert(finished,'Promotion run history exceeds bounded review window');assert.equal(count,total);assert.equal(original,1);assert.equal(seen,1,'Actual first resume run missing from authoritative history');
}
export function requireRuntimeDraftReservation(release,validated){
 assert(positive(release.id));if(validated.resume)assert.equal(release.id,UNSIGNED_RUNTIME_DRAFT.releaseId);
 assert.equal(release.tag_name,validated.tag);assert.equal(release.name,validated.tag);assert.equal(release.draft,true);assert.equal(release.prerelease,false);assert.equal(release.immutable,false);assert.equal(release.published_at,null);assert.equal(release.target_commitish,validated.head);assert.equal(release.body,runtimeDraftBody(validated.head,validated.sequence));assert.equal(release.author.login,'github-actions[bot]');assert.equal(release.author.id,41898282);
 assert.equal(release.url,`https://api.github.com/repos/${REPOSITORY}/releases/${release.id}`);assert.equal(release.assets_url,release.url+'/assets');assert.equal(release.upload_url,`https://uploads.github.com/repos/${REPOSITORY}/releases/${release.id}/assets{?name,label}`);
}
// Unpublished GitHub drafts expose an untagged token; signed payload URLs remain canonical after publication.
export function requireReleaseAssetMetadata(release,asset,tag){
 assert(/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag));assert(positive(release.id)&&positive(asset.id)&&positive(asset.size));assert.equal(release.tag_name,tag);assert.equal(release.url,`https://api.github.com/repos/${REPOSITORY}/releases/${release.id}`);assert.equal(release.assets_url,release.url+'/assets');assert.equal(asset.state,'uploaded');assert(/^sha256:[a-f0-9]{64}$/.test(asset.digest));
 const base=`https://github.com/${REPOSITORY}/releases/`,canonical=base+'tag/'+release.tag_name;
 assert(release.draft===true||release.draft===false);assert(release.html_url===canonical||release.draft===true&&new RegExp('^'+base.replaceAll('.','\\.')+'tag/untagged-[a-f0-9]{20}$').test(release.html_url),'Foreign or malformed draft HTML URL');
 assert.equal(asset.url,`https://api.github.com/repos/${REPOSITORY}/releases/assets/${asset.id}`);assert(/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(asset.name));const url=base+'download/';assert([url+release.tag_name+'/'+asset.name,url+release.html_url.slice((base+'tag/').length)+'/'+asset.name].includes(asset.browser_download_url),'Foreign or mismatched draft asset URL');
}
export function requireUnsignedRuntimeDraft(release,validated){
 requireRuntimeDraftReservation(release,validated);assert.deepEqual(validated.targets.map(t=>t.target).sort(),[...TARGETS].sort());assert.equal(release.assets.length,3);assert.equal(new Set(release.assets.map(a=>a.id)).size,3);
 for(const entry of validated.targets){const matches=release.assets.filter(a=>a.name===`runtime-${entry.target}.tar.gz`);assert.equal(matches.length,1,'Missing/foreign/partial/signed archive checkpoint');const asset=matches[0];assert(positive(asset.id));assert.equal(asset.state,'uploaded');assert.equal(asset.size,entry.payload.bytes);assert.equal(asset.digest,'sha256:'+entry.payload.sha256);requireReleaseAssetMetadata(release,asset,validated.tag);
  if(validated.resume){const expected=UNSIGNED_RUNTIME_DRAFT.assets[entry.target];assert.equal(asset.id,expected.id);assert.equal(asset.size,expected.bytes);assert.equal(entry.payload.sha256,expected.sha256);}
 }
}
export function requireRuntimeAssetBytes(asset,bytes){assert.equal(bytes.length,asset.size);assert.equal('sha256:'+digest(bytes),asset.digest,'Existing archive bytes differ from exact native payload');}
export function requireAvailableRuntimeSequence(api,publicKey,tag,sequence,owned){
 let highest=0,finished=false,seen=0;
 for(let page=1;page<=100;page++){
  const releases=JSON.parse(api(`repos/${REPOSITORY}/releases?per_page=100&page=${page}`));assert(Array.isArray(releases));
  for(const release of releases){
   if(owned&&release.id===owned.release.id){requireUnsignedRuntimeDraft(release,owned.validated);assert.equal(release.id,owned.release.id);assert.deepEqual(release.assets.map(a=>[a.id,a.name,a.size,a.digest]).sort(),owned.release.assets.map(a=>[a.id,a.name,a.size,a.digest]).sort(),'Unsigned asset identities changed during history review');seen++;continue;}
   assert.notEqual(release.tag_name,tag,'Release/tag already exists; inspect prior actions instead of replaying or clobbering');const reservations=(release.body??'').split('\n').filter(line=>line.startsWith('RUNTIME_SEQUENCE='));assert(reservations.length<=1,'Ambiguous draft sequence reservation');if(reservations.length){assert(/^RUNTIME_SEQUENCE=[1-9][0-9]*$/.test(reservations[0]));const reserved=Number(reservations[0].slice(17));assert(Number.isSafeInteger(reserved));highest=Math.max(highest,reserved);}
   for(const asset of release.assets.filter(a=>/^runtime-(linux-x64|win32-x64|darwin-arm64)\.json\.sig$/.test(a.name)))assert.equal(release.assets.filter(a=>a.name===asset.name.slice(0,-4)).length,1,'Orphan runtime signature makes release history ambiguous');
   for(const asset of release.assets.filter(a=>/^runtime-(linux-x64|win32-x64|darwin-arm64)\.json$/.test(a.name))){const sig=release.assets.filter(a=>a.name===asset.name+'.sig');assert.equal(sig.length,1,'Existing signed metadata is incomplete; no new sequence may bypass it');assert(asset.size>0&&asset.size<=65536&&sig[0].size===64);assert(Number.isSafeInteger(asset.id)&&Number.isSafeInteger(sig[0].id));const bytes=api(`repos/${REPOSITORY}/releases/assets/${asset.id}`,'-H','Accept: application/octet-stream'),signature=api(`repos/${REPOSITORY}/releases/assets/${sig[0].id}`,'-H','Accept: application/octet-stream'),header=authenticateManifest(bytes,signature,publicKey,release.id,release.tag_name);highest=Math.max(highest,header.sequence);}
  }
  if(releases.length<100){finished=true;break;}
 }
 assert(finished,'Release history exceeds bounded review window');if(owned)assert.equal(seen,1,'Owned unsigned reservation is missing or ambiguous in history');assert(sequence>highest,'Production sequence must exceed every authenticated or draft-reserved sequence');if(highest===0){assert.equal(sequence,1);assert.equal(tag,'v0.1.0');}
}
