import assert from 'node:assert/strict';
import {lstat,realpath,readdir,open} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';

export const metricsHeaderLimit=4096;
export const metricsFormatPrimary={commit:'861389936bf33ea77529ee5dcc0605e68f6bb620',sources:[
  {path:'base/metrics/persistent_memory_allocator.cc',sha256:'791257dea02d9545709e39a33996594c4993420b02039d7ca7808a65098ba542',lines:'53-67,107-149,355-361,430-436,918-983,1002-1015'},
  {path:'base/metrics/persistent_memory_allocator.h',sha256:'86413f08d8a18ad4629244d04495cc1f3edc908625adb82b320de641d8839069',lines:'119,465-493'}
],url:'https://chromium.googlesource.com/chromium/src/+/861389936bf33ea77529ee5dcc0605e68f6bb620/'};
// Header recognition is evidence, not validation of histogram payloads or permission to mutate files.
export function decodeMetricsHeader(header) {
  assert(header.length<=metricsHeaderLimit,'Header evidence must not exceed4KiB');
  const unknown=reason=>({status:'UNKNOWN',reason});
  if(header.length<64)return unknown('Truncated shared metadata');
  if(header.readUInt32LE(0)!==0x408305dc||header.readUInt32LE(12)!==3)return unknown('Cookie/version differ from pinned upstream v3 layout');
  const ref=header.readUInt32LE(24);
  if(ref<64||ref%8!==0||ref+16>header.length)return unknown('Name reference outside bounded header or misaligned');
  const size=header.readUInt32LE(ref);
  if(size<=16||size%8!==0||ref+size>header.length||header.readUInt32LE(ref+4)!==0xc8799269||header.readUInt32LE(ref+8)!==0)return unknown('Name allocation differs from pinned upstream layout or exceeds bounded evidence');
  const name=header.subarray(ref+16,ref+size),end=name.indexOf(0);
  if(end<1||!name.subarray(0,end).every(byte=>byte>=32&&byte<=126))return unknown('No bounded nonempty ASCII allocator name');
  return {status:'UPSTREAM_V3_HEADER_OBSERVED',cookie:'0x408305dc',version:3,nameReference:ref,allocatorName:name.subarray(0,end).toString('ascii')};
}
const identity=stat=>({dev:stat.dev,ino:stat.ino,size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs});
const pathKey=path=>process.platform==='win32'?path.toLowerCase():path;
export async function captureEdgeMetrics(sourceDirectory,files=[]) {
  const directory=resolve(sourceDirectory,'SetupMetrics'),info=await lstat(directory);assert(info.isDirectory()&&!info.isSymbolicLink(),'SetupMetrics must be a real installed-source directory');
  assert.equal(pathKey(await realpath(directory)),pathKey(directory),'SetupMetrics must not redirect outside installed source');
  const entries=(await readdir(directory,{withFileTypes:true})).filter(entry=>/^[0-9]+_[0-9]+(?:_[0-9]+)?\.pma$/.test(entry.name)).sort((a,b)=>a.name.localeCompare(b.name));
  assert(entries.length>0&&entries.length<=64,'Expected1..64 numeric installer PMA files, without directory traversal');
  for(const entry of entries){
    assert(entry.isFile()&&!entry.isSymbolicLink(),'Numeric PMA must be a regular file');const path=join(directory,entry.name),before=await lstat(path);assert(before.isFile()&&!before.isSymbolicLink(),'Never follow a PMA symlink');assert.equal(pathKey(await realpath(path)),pathKey(path),'PMA must remain within the nonredirected source directory');
    const handle=await open(path,'r');let failure;
    try{
      assert.deepEqual(identity(await handle.stat()),identity(before),'PMA identity changed before read');const hash=createHash('sha256'),header=Buffer.alloc(metricsHeaderLimit);let count=0,headerBytes=0;
      for await(const chunk of handle.createReadStream({autoClose:false})){hash.update(chunk);const copied=Math.min(chunk.length,metricsHeaderLimit-headerBytes);if(copied>0){chunk.copy(header,headerBytes,0,copied);headerBytes+=copied;}count+=chunk.length;}
      assert.equal(count,before.size);assert.deepEqual(identity(await handle.stat()),identity(before),'PMA changed during read');assert.deepEqual(identity(await lstat(path)),identity(before),'PMA path changed during read');
      const bytes=header.subarray(0,headerBytes);files.push({relativePath:`SetupMetrics/${entry.name}`,size:count,sha256:hash.digest('hex'),headerHex:bytes.toString('hex'),format:decodeMetricsHeader(bytes)});
    }catch(error){failure=error;}
    try{await handle.close();}catch(error){failure=failure?new AggregateError([failure,error],`${failure}; PMA close: ${error}`):error;}
    if(failure)throw failure;
  }
  return files;
}
