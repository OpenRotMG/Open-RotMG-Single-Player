import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {generateKeyPairSync,sign} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {Header} from 'tar';
import assert from 'node:assert/strict';
import {digest,hashFile,REPOSITORY,targetName,verifyCapabilities,verifyRuntime} from '../dist/update-format.js';
import {archiveRuntime} from './runtime-payload.mjs';

// These intentionally malicious bytes are only fixture inputs, never qualified upstream artifacts.
function unsafeArchive(type){
 const body=Buffer.from('unsafe fixture'),header=Buffer.alloc(512);new Header({path:type==='path'?'../escape':'client/link',type:type==='path'?'File':'SymbolicLink',linkpath:type==='path'?undefined:'../../escape',size:body.length,mode:0o600,mtime:new Date(0)}).encode(header);
 return gzipSync(Buffer.concat([header,body,Buffer.alloc(512-body.length),Buffer.alloc(1024)]));
}
export async function runtimeFixture({out,runtime,archive,archiveInfo,target=targetName()}){
 const save=JSON.parse(await readFile(join(runtime,'notices/runtime-capabilities.json'),'utf8')).save;
 const identity=await verifyRuntime(runtime,target);await verifyCapabilities(runtime,identity.pins,1,1);const keys=generateKeyPairSync('ed25519'),foreignKeys=generateKeyPairSync('ed25519'),publicKey=keys.publicKey.export({type:'spki',format:'pem'}).toString();
 if(!archive){archive=join(out,`fixture-runtime-${target}.tar.gz`);archiveInfo=await archiveRuntime(runtime,archive,{startupBackup:1,clientNamespace:1});}
 assert.equal(archiveInfo.target,target);assert.deepEqual(archiveInfo.pins,identity.pins);assert.equal((await stat(archive)).size,archiveInfo.payload.bytes);assert.equal(await hashFile(archive),archiveInfo.payload.sha256);assert.equal(archiveInfo.startupBackup,1);assert.equal(archiveInfo.clientNamespace,1);assert.equal(archiveInfo.payload.binarySha256,identity.binarySha256);
 let mode='503',sequence=2,hold=false,held=[];const requests=[],errors=[];
 const server=createServer((request,response)=>{
  const path=new URL(request.url,'http://fixture.invalid').pathname,entry={method:request.method,path,at:new Date().toISOString(),mode,status:null};requests.push(entry);response.once('finish',()=>{entry.status=response.statusCode;});
  if(request.method!=='GET'){errors.push('Unexpected non-GET runtime request; no request body was recorded');response.writeHead(405);response.end();return;}
  if(path.endsWith('/latest')&&hold){held.push(response);response.on('close',()=>{held=held.filter(item=>item!==response);});return;}
  serve(path,response);
 });
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const origin=`http://127.0.0.1:${server.address().port}`,discovery=`${origin}/api/repos/${REPOSITORY}/releases/latest`;
 const send=(response,bytes,length=bytes.length)=>{response.writeHead(200,{'content-length':length});response.end(bytes);};
 function generation(){
  const tag=`fixture-C-${identity.pins.server.commit.slice(0,12)}-${sequence}`,payload={...archiveInfo.payload,id:20000+sequence,name:`runtime-${target}.tar.gz`,url:`${origin}/${REPOSITORY}/releases/download/${tag}/runtime-${target}.tar.gz`};
  let synthetic;
  if(mode==='wrong-digest')payload.sha256='0'.repeat(64);
  if(mode==='unsafe-path'||mode==='symlink'){synthetic=unsafeArchive(mode==='unsafe-path'?'path':'symlink');payload.bytes=synthetic.length;payload.sha256=digest(synthetic);payload.expandedBytes=14;}
  const manifest={format:1,releaseId:10000+sequence,tag,version:`fixture-${identity.pins.server.commit.slice(0,12)}-${sequence}`,sequence,target,minLauncher:save.write===23?'0.1.1':'0.1.0',clientNamespace:1,save,pins:identity.pins,payload};
  if(mode==='future')manifest.format=2;if(mode==='wrong-target')manifest.target=target==='linux-x64'?'win32-x64':'linux-x64';if(mode==='minimum-launcher')manifest.minLauncher='999.0.0';if(mode==='future-key')manifest.keyId='untrusted-future-key';if(mode==='legacy-capability')manifest.save.startupBackup=0;
  let bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');if(mode==='malformed')bytes=Buffer.from('{not valid JSON');if(mode==='invalid-utf8')bytes=Buffer.from([255]);
  const signature=mode==='signature'?Buffer.alloc(64):sign(null,bytes,mode==='wrong-key'?foreignKeys.privateKey:keys.privateKey);return{manifest,bytes,signature,synthetic};
 }
 function serve(path,response){
  if(['503','429'].includes(mode)){response.writeHead(Number(mode),{'x-ratelimit-remaining':mode==='429'?'0':'1'});response.end('controlled runtime service failure');return;}
  if(mode==='timeout')return;
  if(mode==='redirect'){response.writeHead(302,{location:'https://untrusted.invalid/no-runtime?fixture-secret-not-for-logs=1'});response.end();return;}
  const g=generation(),m=g.manifest;
  if(path.endsWith('/latest')){
   const assets=[{id:30000+sequence,name:`runtime-${target}.json`,size:g.bytes.length},{id:40000+sequence,name:`runtime-${target}.json.sig`,size:g.signature.length},{id:m.payload.id,name:m.payload.name,size:m.payload.bytes}].map(a=>({...a,browser_download_url:`${origin}/${REPOSITORY}/releases/download/${m.tag}/${a.name}`}));
   send(response,Buffer.from(JSON.stringify({id:m.releaseId,tag_name:m.tag,draft:false,prerelease:false,immutable:true,url:discovery.replace('/latest',`/${m.releaseId}`),assets})));return;
  }
  const base=`/${REPOSITORY}/releases/download/${m.tag}/`;
  if(path===base+`runtime-${target}.json`){send(response,g.bytes);return;}
  if(path===base+`runtime-${target}.json.sig`){send(response,g.signature);return;}
  if(path===base+`runtime-${target}.tar.gz`){
   if(g.synthetic){send(response,g.synthetic);return;}
   if(mode==='truncated'){response.writeHead(200,{'content-length':m.payload.bytes});response.end(Buffer.from('truncated fixture'));return;}
   response.writeHead(200,{'content-length':m.payload.bytes});const input=createReadStream(archive);input.on('error',error=>{errors.push(`Fixture payload read failed: ${error.code}`);response.destroy();});response.on('close',()=>input.destroy());input.pipe(response);return;
  }
  response.writeHead(404);response.end();
 }
 return{
  origin,publicKey,requests,errors,identity,archive,archiveInfo,
  policy:baseline=>({target,baseline,discovery,assetOrigin:origin,redirectOrigins:[origin],publicKey,request:fetch,metadataDeadline:20000,payloadDeadline:180000}),
  set:(next,nextSequence=sequence)=>{assert(['good','503','429','signature','wrong-key','future','wrong-target','minimum-launcher','future-key','legacy-capability','malformed','invalid-utf8','wrong-digest','unsafe-path','symlink','truncated','timeout','redirect'].includes(next));mode=next;sequence=nextSequence;},
  hold:()=>{hold=true;},held:()=>held.length,
  release:()=>{hold=false;const responses=held;held=[];for(const response of responses)serve(new URL(discovery).pathname,response);},
  current:()=>generation().manifest,
  close:async()=>{for(const response of held)response.destroy();server.closeAllConnections();await new Promise(ok=>server.close(ok));},
 };
}
