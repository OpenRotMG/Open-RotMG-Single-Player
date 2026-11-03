import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,cp,rm,lstat,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {tree} from '../scripts/assets.mjs';
import {captureEdgeMetrics,decodeMetricsHeader} from '../scripts/windows-metrics-format.mjs';
import {ownedEdgeMode,openOwnedEdgePage,requireMicrosoftEdgePublisher,requireOwnedEdgeRulePrograms,requireOwnedEdgeInventory,requireOwnedEdgeIdentity,ownedEdgeImageDifference,requireOwnedEdgeAfterRun,classifyOwnedEdgeInstallerMetrics} from '../scripts/windows-owned-edge.mjs';
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
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function metricsBytes(name='SetupMetrics',size=128){const bytes=Buffer.alloc(size);bytes.writeUInt32LE(0x408305dc,0);bytes.writeUInt32LE(size,4);bytes.writeUInt32LE(3,12);bytes.writeUInt32LE(64,24);bytes.writeUInt32LE(32,64);bytes.writeUInt32LE(0xc8799269,68);bytes.write(name,80,'ascii');return bytes;}
function metricsRecord(path='SetupMetrics/701_13450000000000000_701.pma',bytes=metricsBytes()){const header=bytes.subarray(0,4096);return {relativePath:path,size:bytes.length,sha256:digest(bytes),headerHex:header.toString('hex'),format:decodeMetricsHeader(header)};}
function metricsImage(records=[metricsRecord()]){
  const original={files:{'msedge.exe':digest('code'),'156/resource.dll':digest('resource'),'SetupMetrics/unclassified.pma':digest('unknown')},sha256:'full'};for(const file of records)original.files[file.relativePath]=file.sha256;
  return {original,copyBeforeRun:structuredClone(original),sourceAfterRun:structuredClone(original),copyAfterRun:structuredClone(original),sourceImage:{executable:'C:\\installed\\msedge.exe',product:'Microsoft Edge',company:'Microsoft Corporation',signature:'Valid',signer:'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US',sha256:original.files['msedge.exe']},metricsBeforeRun:records,metricsCopySizesBeforeRun:Object.fromEntries(records.map(file=>[file.relativePath,file.size]))};
}
test('windows-owned-edge live source capture binds headers, sizes and hashes to full copy inventory before data-only deletions',async t=>{
  await mkdir('.qa/unit',{recursive:true});const root=await mkdtemp(resolve('.qa/unit/live-edge-metrics-'));t.after(()=>rm(root,{recursive:true}));const source=join(root,'source'),copy=join(root,'owned');await mkdir(join(source,'SetupMetrics'),{recursive:true});await writeFile(join(source,'msedge.exe'),'code');
  for(const [name,bytes] of [['701_13450000000000000_701.pma',metricsBytes()],['702_13450000000000000.pma',metricsBytes('SetupMetrics',8192)]])await writeFile(join(source,'SetupMetrics',name),bytes);
  const image=metricsImage();image.original=await tree(source,['']);await cp(source,copy,{recursive:true});image.copyBeforeRun=await tree(copy,['']);image.metricsBeforeRun=[];await captureEdgeMetrics(source,image.metricsBeforeRun);image.metricsCopySizesBeforeRun={};
  for(const file of image.metricsBeforeRun)image.metricsCopySizesBeforeRun[file.relativePath]=(await lstat(join(copy,file.relativePath))).size;
  const classified=classifyOwnedEdgeInstallerMetrics(image);assert.equal(classified.length,2);assert.equal(classified[0].primary.commit,'861389936bf33ea77529ee5dcc0605e68f6bb620');assert.match(classified[0].classification,/NOT full histogram payload validation/);
  image.sourceAfterRun=await tree(source,['']);image.copyAfterRun=await tree(copy,['']);assert.deepEqual(requireOwnedEdgeAfterRun(image).consumedInstallerMetrics,[]);
  for(const file of image.metricsBeforeRun)await rm(join(copy,file.relativePath));image.copyAfterRun=await tree(copy,['']);assert.throws(()=>requireOwnedEdgeInventory(image.original,image.sourceAfterRun,image.copyAfterRun));
  const result=requireOwnedEdgeAfterRun(image);assert.equal(result.consumedInstallerMetrics.length,2);for(const entry of result.consumedInstallerMetrics){assert.equal(entry.beforeSha256,entry.beforeClassification.sha256);assert.equal(entry.path,entry.beforeClassification.relativePath);assert(entry.beforeClassification.headerHex.length<=8192);assert.equal(entry.beforeClassification.sourceRefs.length,3);}assert.deepEqual(ownedEdgeImageDifference(image.original,image.copyAfterRun).deleted.map(entry=>entry.path),image.metricsBeforeRun.map(file=>file.relativePath));
});
test('windows-owned-edge data classification rejects missing, duplicate, wrong namespace/hash/size/header and untrusted publisher evidence',()=>{
  for(const mutate of [image=>delete image.metricsBeforeRun,image=>image.metricsBeforeRun=[],image=>image.metricsBeforeRun.push(image.metricsBeforeRun[0]),image=>delete image.metricsCopySizesBeforeRun,image=>image.metricsCopySizesBeforeRun={},image=>image.metricsBeforeRun[0].sha256='f'.repeat(64),image=>image.metricsBeforeRun[0].size++,image=>image.metricsBeforeRun[0].headerHex+='00',image=>image.metricsBeforeRun[0].headerHex='zz',image=>image.metricsBeforeRun[0].format.status='UNKNOWN',image=>image.sourceImage.company='Other Publisher',image=>image.sourceImage.signature='Invalid',image=>image.sourceImage.product='Other Microsoft product',image=>image.sourceImage.sha256='wrong-root',image=>image.copyBeforeRun.files['156/resource.dll']='changed']){const image=metricsImage();mutate(image);assert.throws(()=>classifyOwnedEdgeInstallerMetrics(image));}
  for(const path of ['msedge.exe','SetupMetrics/msedge.exe','SetupMetrics/other.pma','SetupMetrics/subdir/1_2.pma','../SetupMetrics/1_2.pma','SetupMetrics/../msedge.exe','SetupMetrics\\1_2.pma'])assert.throws(()=>classifyOwnedEdgeInstallerMetrics(metricsImage([metricsRecord(path)])),/namespace/);
  const partial=metricsImage([metricsRecord(),metricsRecord('SetupMetrics/702_13450000000000000.pma')]);partial.metricsBeforeRun.pop();assert.throws(()=>classifyOwnedEdgeInstallerMetrics(partial),/Missing live/);
  for(const [offset,value] of [[0,0],[12,2],[12,4]]){const bytes=metricsBytes();bytes.writeUInt32LE(value,offset);assert.throws(()=>classifyOwnedEdgeInstallerMetrics(metricsImage([metricsRecord(undefined,bytes)])),/UNKNOWN/);}
  assert.throws(()=>classifyOwnedEdgeInstallerMetrics(metricsImage([metricsRecord(undefined,metricsBytes('Other'))])),/allocator name/);
  const corrupt=metricsImage();const header=Buffer.from(corrupt.metricsBeforeRun[0].headerHex,'hex');header[127]=1;corrupt.metricsBeforeRun[0].headerHex=header.toString('hex');assert.throws(()=>classifyOwnedEdgeInstallerMetrics(corrupt),/Complete captured/);
});
test('windows-owned-edge UNKNOWN never falls back to the historical filename or accepted hash',()=>{
  const bytes=metricsBytes();bytes.writeUInt32LE(2,12);const record=metricsRecord('SetupMetrics/3960_13436344830356102_3960.pma',bytes);record.sha256='c9bf34f471c0ac43e064875bd9a6f27bbf6a9fe876dce7ab84ce7643d2661def';const image=metricsImage([record]);delete image.copyAfterRun.files[record.relativePath];assert.throws(()=>classifyOwnedEdgeInstallerMetrics(image),/UNKNOWN/);assert.throws(()=>requireOwnedEdgeAfterRun(image),/UNKNOWN/);
});
test('windows-owned-edge after-run rejects every addition/modification/unclassified deletion and changed source',()=>{
  const original=metricsImage(),path=original.metricsBeforeRun[0].relativePath;delete original.copyAfterRun.files[path];assert.equal(requireOwnedEdgeAfterRun(original).consumedInstallerMetrics.length,1);
  for(const name of Object.keys(original.original.files)){
    const changed=structuredClone(original);changed.copyAfterRun.files[name]='modified';assert.throws(()=>requireOwnedEdgeAfterRun(changed));
    if(name!==path){const deleted=structuredClone(original);delete deleted.copyAfterRun.files[name];assert.throws(()=>requireOwnedEdgeAfterRun(deleted),/Unclassified/);}
    const source=structuredClone(original);source.sourceAfterRun.files[name]='source-changed';assert.throws(()=>requireOwnedEdgeAfterRun(source),/source image changed/);
  }
  for(const name of ['156/new.dll','SetupMetrics/new-metadata.pma','SetupMetrics/999_13450000000000000.pma']){const added=structuredClone(original);added.copyAfterRun.files[name]='new';assert.throws(()=>requireOwnedEdgeAfterRun(added),/additions/);}
});
test('windows-owned-edge probe classifies live evidence before rules or browser and preserves final report distinctions',async()=>{
  const script=await readFile(new URL('../scripts/windows-owned-offline.mjs',import.meta.url),'utf8'),entry=await readFile(new URL('../scripts/windows-offline-probe.mjs',import.meta.url),'utf8');const capture=script.indexOf('await captureEdgeMetrics(image.sourceDirectory,image.metricsBeforeRun)'),strict=script.indexOf('requireOwnedEdgeInventory(image.original,image.sourceAfterCopy,image.copyBeforeRun)'),classification=script.indexOf('image.prevalidatedInstallerMetrics=classifyOwnedEdgeInstallerMetrics(image)'),rules=script.indexOf('New-NetFirewallRule'),launch=script.indexOf('await ownedBrowserCanary');assert(capture>0&&capture<strict&&strict<classification&&classification<rules&&rules<launch);assert(entry.includes('createWindowsOwnedOffline({report,out,tmp,installed:null'));assert(script.includes('image.afterRunDifference=ownedEdgeImageDifference'));assert(script.includes('image.wholeApplicationDirUnchanged='));assert(script.indexOf('assert.deepEqual(image.copyMetadataAfterRun,image.copyMetadataBeforeRun)')<script.indexOf('image.immutableRuntimeVerified=true'));
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
