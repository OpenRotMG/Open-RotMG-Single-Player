import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {readFile,stat} from 'node:fs/promises';
import {discover,downloadPayload} from '../dist/update-network.js';
import {directory,unitRuntime,manifestFor,keyPair,publicPEM,signed} from './update-fixture.mjs';

async function publisher(t){
 const root=await directory('update-network'),runtime=join(root,'runtime');await unitRuntime(runtime);const keys=keyPair();let mode='good',manifest,bytes,signature,payload;
 const server=createServer((request,response)=>{
  if(mode==='503'||mode==='429'){response.writeHead(Number(mode),{'x-ratelimit-remaining':mode==='429'?'0':'1'});response.end('never interpreted as offline');return;}
  if(mode==='timeout')return;
  if(mode==='redirect'){response.writeHead(302,{location:'https://evil.invalid/no'});response.end();return;}
  if(mode==='loop'){response.writeHead(302,{location:request.url});response.end();return;}
  const send=(body,length=body.length)=>{response.writeHead(200,{'content-length':length});response.end(body);};
  if(request.url.endsWith('/latest')){
   const assets=[{id:301,name:'runtime-linux-x64.json',size:bytes.length},{id:401,name:'runtime-linux-x64.json.sig',size:signature.length},{id:manifest.payload.id,name:manifest.payload.name,size:payload.length}].map(a=>({...a,browser_download_url:`${origin}/OpenRotMG/Open-RotMG-Single-Player/releases/download/${manifest.tag}/${a.name}`}));
   if(mode==='asset-id')assets[2].id++;
   send(Buffer.from(JSON.stringify({id:manifest.releaseId,tag_name:manifest.tag,draft:false,prerelease:false,url:policy.discovery.replace('/latest',`/${manifest.releaseId}`),assets})));return;
  }
  if(request.url.endsWith('.json.sig')){send(mode==='signature'?Buffer.alloc(64):signature);return;}
  if(request.url.endsWith('.json')){send(bytes);return;}
  if(request.url.endsWith('.tar.gz')){send(mode==='truncated'?payload.subarray(0,payload.length-10):payload,payload.length);return;}
  response.writeHead(404);response.end();
 });
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const origin=`http://127.0.0.1:${server.address().port}`;
 t.after(async()=>{server.closeAllConnections();await new Promise(ok=>server.close(ok));});
 const policy={target:'linux-x64',launcher:'0.1.0',baseline:{root:runtime,mode:'source',identitySha256:'a'.repeat(64)},discovery:`${origin}/api/repos/OpenRotMG/Open-RotMG-Single-Player/releases/latest`,assetOrigin:origin,redirectOrigins:[origin],publicKey:publicPEM(keys),request:fetch,metadataDeadline:5000,payloadDeadline:5000};
 manifest=await manifestFor(runtime,join(root,'runtime.tar.gz'),origin);payload=await readFile(join(root,'runtime.tar.gz'));
 const update=mutate=>{const next=structuredClone(manifest);mutate(next);({bytes,signature}=signed(next,keys));};update(()=>{});
 return{root,policy,manifest,mode:value=>{mode=value;},update};
}
test('update-network resolves one exact generation and streams the signature-bound payload',async t=>{
 const f=await publisher(t),signal=new AbortController().signal,result=await discover(f.policy,signal);assert.deepEqual(result.manifest,f.manifest);
 const path=join(f.root,'download.tar.gz');await downloadPayload(result.manifest,path,f.policy,signal);assert.equal((await stat(path)).size,result.manifest.payload.bytes);
});
test('update-network HTTP503 and rate limits stay specific service failures, not offline',async t=>{
 const f=await publisher(t);for(const status of ['503','429']){f.mode(status);await assert.rejects(discover(f.policy,new AbortController().signal),e=>e.kind==='service'&&e.message.includes(status));}
});
test('update-network DNS/connect/deadline unavailability differs from cancellation and unclassified faults',async t=>{
 const f=await publisher(t);for(const code of ['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ENETUNREACH','ETIMEDOUT']){
  await assert.rejects(discover({...f.policy,request:async()=>{throw new TypeError('redacted',{cause:{code}});}},new AbortController().signal),e=>e.kind==='unavailable'&&e.message.includes(code));
 }
 await assert.rejects(discover({...f.policy,request:async()=>{throw new TypeError('do not log arbitrary URL?secret=credential');}},new AbortController().signal),e=>e.kind==='rejected'&&!e.message.includes('credential'));
 f.mode('timeout');await assert.rejects(discover({...f.policy,metadataDeadline:150},new AbortController().signal),e=>e.kind==='unavailable'&&e.message.includes('TimeoutError'));
 const controller=new AbortController();controller.abort();await assert.rejects(discover(f.policy,controller.signal),e=>e.kind==='canceled');
});
test('update-network rejects untrusted redirects, loops, replaced assets and invalid signatures',async t=>{
 const f=await publisher(t);for(const mode of ['redirect','loop','asset-id','signature']){f.mode(mode);await assert.rejects(discover(f.policy,new AbortController().signal),e=>e.kind==='rejected');}
});
test('update-network rejects digest mismatch and actual truncated transfer without claiming completion',async t=>{
 const f=await publisher(t),signal=new AbortController().signal;f.update(m=>m.payload.sha256='0'.repeat(64));const bad=await discover(f.policy,signal);
 await assert.rejects(downloadPayload(bad.manifest,join(f.root,'bad.tar.gz'),f.policy,signal),/digest\/size mismatch/);
 f.update(()=>{});const good=await discover(f.policy,signal);f.mode('truncated');await assert.rejects(downloadPayload(good.manifest,join(f.root,'cut.tar.gz'),f.policy,signal),e=>e.kind==='rejected'&&e.message.includes('Incomplete runtime'));
});
test('update-network never reclassifies a local staging filesystem failure as offline',async t=>{
 const f=await publisher(t),signal=new AbortController().signal,result=await discover(f.policy,signal);
 await assert.rejects(downloadPayload(result.manifest,join(f.root,'missing','file'),f.policy,signal),e=>e.code==='ENOENT'&&e.kind!=='unavailable');
});
