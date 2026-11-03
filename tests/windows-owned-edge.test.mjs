import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,cp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tree} from '../scripts/assets.mjs';
import {ownedEdgeMode,requireOwnedEdgeRulePrograms,requireOwnedEdgeInventory,requireOwnedEdgeIdentity} from '../scripts/windows-owned-edge.mjs';
import {edgeImageAt} from '../scripts/windows-edge-image.mjs';

test('windows-owned-edge requires explicit named mode and never falls back from missing copied image',()=>{
  assert.equal(ownedEdgeMode([]),false);assert.equal(ownedEdgeMode(['--owned-edge-image']),true);assert.throws(()=>ownedEdgeMode(['--automatic']));assert.throws(()=>ownedEdgeMode(['--owned-edge-image','--retry']));assert.throws(()=>edgeImageAt('relative/msedge.exe'),/absolute Edge image/);
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
test('windows-owned-edge rejects system-image adoption, altered bytes/version/signature and missing metadata',()=>{
  const source={executable:'C:\\installed\\msedge.exe',product:'Microsoft Edge',company:'Microsoft Corporation',fileVersion:'156',signature:'Valid',signer:'Microsoft',sha256:'original'},copy={...source,executable:'D:\\owned\\msedge.exe'};
  requireOwnedEdgeIdentity(source,copy);requireOwnedEdgeRulePrograms(['owned-node.exe',copy.executable],'owned-node.exe',source,copy);assert.throws(()=>requireOwnedEdgeRulePrograms(['owned-node.exe',source.executable],'owned-node.exe',source,copy));
  for(const changed of [{executable:source.executable},{sha256:'altered'},{fileVersion:'different'},{signature:'Invalid'}])assert.throws(()=>requireOwnedEdgeIdentity(source,{...copy,...changed}));
  assert.throws(()=>requireOwnedEdgeIdentity({...source,fileVersion:undefined},{...copy,fileVersion:undefined}));
});
