import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {captureEdgeMetrics,decodeMetricsHeader,metricsHeaderLimit} from '../scripts/windows-metrics-format.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(name='SetupMetrics'){
  const bytes=Buffer.alloc(8192);bytes.writeUInt32LE(0x408305dc,0);bytes.writeUInt32LE(bytes.length,4);bytes.writeUInt32LE(3,12);bytes.writeUInt32LE(64,24);bytes.writeUInt32LE(32,64);bytes.writeUInt32LE(0xc8799269,68);bytes.write(name,80,'ascii');return bytes;
}
async function source(t){await mkdir('.qa',{recursive:true});const root=await mkdtemp(join(process.cwd(),'.qa','metrics-format-test-'));t.after(()=>rm(root,{recursive:true}));await mkdir(join(root,'SetupMetrics'));return root;}
test('windows-metrics-format decodes only bounded pinned upstream v3 header evidence, never data admission',()=>{
  const header=fixture().subarray(0,metricsHeaderLimit);assert.deepEqual(decodeMetricsHeader(header),{status:'UPSTREAM_V3_HEADER_OBSERVED',cookie:'0x408305dc',version:3,nameReference:64,allocatorName:'SetupMetrics'});
  assert.equal(decodeMetricsHeader(fixture('Other').subarray(0,metricsHeaderLimit)).allocatorName,'Other');
  for(const length of [0,4,32,63])assert.equal(decodeMetricsHeader(header.subarray(0,length)).status,'UNKNOWN');
  for(const [offset,value] of [[0,0],[12,2],[12,4],[24,32],[24,65],[24,4104],[64,0],[64,16],[64,31],[64,8192],[68,0],[72,1]]){const bytes=Buffer.from(header);bytes.writeUInt32LE(value,offset);assert.equal(decodeMetricsHeader(bytes).status,'UNKNOWN',`${offset}:${value}`);}
  const unterminated=Buffer.from(header);unterminated.fill(65,80,96);assert.equal(decodeMetricsHeader(unterminated).status,'UNKNOWN');const nonAscii=Buffer.from(header);nonAscii[80]=255;assert.equal(decodeMetricsHeader(nonAscii).status,'UNKNOWN');assert.throws(()=>decodeMetricsHeader(fixture()),/4KiB/);
});
test('windows-metrics-format reads only numeric PMAs, binds full-file hash and bounds raw headers without writes',async t=>{
  const root=await source(t),bytes=fixture(),path=join(root,'SetupMetrics','123_456_123.pma');bytes[8191]=99;await writeFile(path,bytes);await writeFile(join(root,'SetupMetrics','456_789.pma'),Buffer.from([1,2,3]));await mkdir(join(root,'SetupMetrics','ignored.pma'));
  const before=await captureEdgeMetrics(root),after=await captureEdgeMetrics(root);assert.deepEqual(after,before);assert.equal(before.length,2);assert.equal(before[0].relativePath,'SetupMetrics/123_456_123.pma');assert.equal(before[0].size,8192);assert.equal(before[0].sha256,hash(bytes));assert.equal(before[0].headerHex.length,metricsHeaderLimit*2);assert.equal(before[1].format.status,'UNKNOWN');assert.deepEqual(await readFile(path),bytes);assert.deepEqual((await readdir(join(root,'SetupMetrics'))).sort(),['123_456_123.pma','456_789.pma','ignored.pma']);
  bytes[8191]=98;await writeFile(path,bytes);const changed=await captureEdgeMetrics(root);assert.equal(changed[0].headerHex,before[0].headerHex);assert.notEqual(changed[0].sha256,before[0].sha256);
});
test('windows-metrics-format rejects empty or oversized enumerations and retains partial capture before an invalid numeric entry',async t=>{
  const root=await source(t);await assert.rejects(captureEdgeMetrics(root),/1\.\.64/);const dir=join(root,'SetupMetrics');await writeFile(join(dir,'1_2.pma'),fixture());await mkdir(join(dir,'2_3.pma'));const partial=[];await assert.rejects(captureEdgeMetrics(root,partial),/regular file/);assert.equal(partial.length,1);await rm(join(dir,'2_3.pma'),{recursive:true});
  for(let i=0;i<65;i++)await writeFile(join(dir,`${i}_99.pma`),Buffer.alloc(1));await assert.rejects(captureEdgeMetrics(root),/1\.\.64/);
});
test('windows-metrics-format rejects symlinked numeric files and redirected directories',{skip:process.platform==='win32'},async t=>{
  const root=await source(t),target=join(root,'unrelated');await writeFile(target,fixture());await symlink(target,join(root,'SetupMetrics','1_2.pma'));await assert.rejects(captureEdgeMetrics(root),/regular file/);await rm(join(root,'SetupMetrics'),{recursive:true});await mkdir(join(root,'elsewhere'));await symlink(join(root,'elsewhere'),join(root,'SetupMetrics'));await assert.rejects(captureEdgeMetrics(root),/real installed-source directory/);
});
