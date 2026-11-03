import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,cp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tree} from '../scripts/assets.mjs';
import {ownedEdgeMode,openOwnedEdgePage,requireMicrosoftEdgePublisher,requireOwnedEdgeRulePrograms,requireOwnedEdgeInventory,requireOwnedEdgeIdentity,ownedEdgeImageDifference,requireOwnedEdgeAfterRun} from '../scripts/windows-owned-edge.mjs';
import {edgeImageAt} from '../scripts/windows-edge-image.mjs';

test('windows-owned-edge requires explicit named mode and never falls back from missing copied image',()=>{
  assert.equal(ownedEdgeMode([]),false);assert.equal(ownedEdgeMode(['--owned-edge-image']),true);assert.throws(()=>ownedEdgeMode(['--automatic']));assert.throws(()=>ownedEdgeMode(['--owned-edge-image','--retry']));assert.throws(()=>edgeImageAt('relative/msedge.exe'),/absolute Edge image/);
});
test('windows-owned-edge explicitly creates its own page regardless of preexisting pages',async()=>{
  let created=0;const page={owned:true};const context={pages:()=>assert.fail('Must not select or fall back from existing pages'),newPage:async()=>{created++;return page;}};
  assert.equal(await openOwnedEdgePage(context),page);assert.equal(created,1);
});
test('windows-owned-edge compares complete original/source/copy inventories and rejects either changed tree',async()=>{
  await mkdir('.qa/unit',{recursive:true});const root=await mkdtemp(resolve('.qa/unit/owned-edge-'));
  try{
    const source=join(root,'source'),copy=join(root,'owned');await mkdir(join(source,'156'),{recursive:true});await writeFile(join(source,'msedge.exe'),'image');await writeFile(join(source,'156/resource.dll'),'resource');
    const original=await tree(source,['']);await cp(source,copy,{recursive:true});requireOwnedEdgeInventory(original,await tree(source,['']),await tree(copy,['']));
    await writeFile(join(copy,'156/resource.dll'),'altered');const alteredCopy=await tree(copy,['']);assert.throws(()=>requireOwnedEdgeInventory(original,original,alteredCopy));
    await writeFile(join(source,'msedge.exe'),'changed-source');const alteredSource=await tree(source,['']);assert.throws(()=>requireOwnedEdgeInventory(original,alteredSource,original));
  }finally{await rm(root,{recursive:true});}
});
test('windows-owned-edge after-run classifies only deletion of the exact observed installer histogram tuple',()=>{
  const path='SetupMetrics/3960_13436344830356102_3960.pma',sha='c9bf34f471c0ac43e064875bd9a6f27bbf6a9fe876dce7ab84ce7643d2661def';
  const original={files:{'msedge.exe':'code','156/resource.dll':'resource',[path]:sha,'SetupMetrics/other.pma':'unknown'},sha256:'full'},files={...original.files};delete files[path];const consumed={files,sha256:'actual-after'};
  assert.throws(()=>requireOwnedEdgeInventory(original,original,consumed),'Before-run must remain exact');
  const result=requireOwnedEdgeAfterRun(original,original,consumed);assert.equal(result.consumedInstallerMetrics.length,1);assert.equal(result.consumedInstallerMetrics[0].path,path);assert.equal(result.consumedInstallerMetrics[0].beforeSha256,sha);assert.equal(result.consumedInstallerMetrics[0].sourceRefs.length,3);
  assert.deepEqual(ownedEdgeImageDifference(original,consumed),{added:[],modified:[],deleted:[{path,beforeSha256:sha}]});assert.equal(original.files[path],sha);assert.deepEqual(requireOwnedEdgeAfterRun(original,original,original).consumedInstallerMetrics,[]);
  const changedOriginal={files:{...original.files,[path]:'different-prehash'},sha256:'changed-source'};assert.throws(()=>requireOwnedEdgeAfterRun(changedOriginal,changedOriginal,consumed));
  for(const name of Object.keys(original.files)){
    assert.throws(()=>requireOwnedEdgeAfterRun(original,original,{files:{...original.files,[name]:'modified'},sha256:'modified'}));
    if(name!==path){const missing={...original.files};delete missing[name];assert.throws(()=>requireOwnedEdgeAfterRun(original,original,{files:missing,sha256:'deleted'}));}
  }
  assert.throws(()=>requireOwnedEdgeAfterRun(original,original,{files:{...files,'SetupMetrics/new.pma':'new'},sha256:'new'}));
  assert.throws(()=>requireOwnedEdgeAfterRun(original,changedOriginal,consumed));
});
test('windows-owned-edge requires exact Microsoft publisher even when valid source and copy agree',()=>{
  const source={executable:'installed/msedge.exe',product:'Microsoft Edge',company:'Other Publisher',fileVersion:'156',signature:'Valid',signer:'CN=Other Publisher',sha256:'same'},copy={...source,executable:'owned/msedge.exe'};
  assert.throws(()=>requireOwnedEdgeIdentity(source,copy),/Microsoft Edge company/);
  assert.throws(()=>requireMicrosoftEdgePublisher({...source,company:'Microsoft Corporation',signer:'Microsoft'}),/signer identity/);
  assert.throws(()=>requireMicrosoftEdgePublisher({...source,company:'Microsoft Corporation',signer:'CN=Microsoft Corporation Attacker, O=Microsoft Corporation, L=Redmond, S=Washington, C=US'}),/signer identity/);
});
test('windows-owned-edge rejects system-image adoption, altered bytes/version/signature and missing metadata',()=>{
  const source={executable:'C:\\installed\\msedge.exe',product:'Microsoft Edge',company:'Microsoft Corporation',fileVersion:'156',signature:'Valid',signer:'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US',sha256:'original'},copy={...source,executable:'D:\\owned\\msedge.exe'};
  requireOwnedEdgeIdentity(source,copy);requireOwnedEdgeRulePrograms(['owned-node.exe',copy.executable],'owned-node.exe',source,copy);assert.throws(()=>requireOwnedEdgeRulePrograms(['owned-node.exe',source.executable],'owned-node.exe',source,copy));
  for(const changed of [{executable:source.executable},{sha256:'altered'},{fileVersion:'different'},{signature:'Invalid'}])assert.throws(()=>requireOwnedEdgeIdentity(source,{...copy,...changed}));
  assert.throws(()=>requireOwnedEdgeIdentity({...source,fileVersion:undefined},{...copy,fileVersion:undefined}));
});
