import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {authenticateManifest,demand, integer, label, Manifest, MAX_METADATA, MAX_PAYLOAD, REPOSITORY, UpdateProblem, verifyManifest, decodeJson} from './update-format';
import {UpdatePolicy} from './update-policy';

type Asset={id:number;name:string;size:number;browser_download_url:string};
export type Release={id:number;tag_name:string;assets:Asset[]};
function transportCode(error:unknown):string{
  const e=error as {name?:unknown;cause?:{code?:unknown};code?:unknown};
  const code=e?.cause?.code??e?.code;
  return typeof code==='string'&&/^[A-Z0-9_]{1,60}$/.test(code)?code:typeof e?.name==='string'&&/^[A-Za-z]{1,40}$/.test(e.name)?e.name:'unclassified transport error';
}
function transportProblem(error:unknown,signal:AbortSignal):never{
  if(signal.aborted)throw new UpdateProblem('canceled','Runtime update check canceled; no update success is claimed');
  const code=transportCode(error);
  const offline=['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','ENETUNREACH','EHOSTUNREACH','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','TimeoutError'];
  throw new UpdateProblem(offline.includes(code)?'unavailable':'rejected',`Could not reach the runtime update service (${code})`);
}
function checkedURL(url:string,policy:UpdatePolicy):URL{
  const parsed=new URL(url);
  demand(policy.redirectOrigins.includes(parsed.origin)&&!parsed.username&&!parsed.password&&!parsed.hash,'Untrusted runtime update origin/credentials/fragment');
  return parsed;
}
async function responseFor(url:string,policy:UpdatePolicy,signal:AbortSignal,canceled:AbortSignal):Promise<Response>{
  const initial=checkedURL(url,policy);let current=initial;
  for(let redirects=0;redirects<=4;redirects++){
    let response:Response;
    try{response=await policy.request(current,{redirect:'manual',signal,headers:{Accept:url===policy.discovery?'application/vnd.github+json':'application/octet-stream','Accept-Encoding':'identity','User-Agent':'OpenRotMG-Single-Player'}});}
    catch(error){return transportProblem(signal.aborted?signal.reason:error,canceled);}
    demand(!response.redirected,'Uncontrolled runtime redirect');
    if([301,302,303,307,308].includes(response.status)){
      const location=response.headers.get('location');
      try{await response.body?.cancel();}catch(error){throw new UpdateProblem('service',`Runtime redirect HTTP ${response.status}; response cleanup failed (${transportCode(error)})`);}
      demand(location&&redirects<4,'Missing runtime redirect location or redirect limit exceeded');
      current=checkedURL(new URL(location,current).href,policy);
      if(current.origin===policy.assetOrigin||current.origin===initial.origin)demand(current.pathname===initial.pathname&&!current.search,'Runtime redirect changed the fixed repository/generation asset path');
      continue;
    }
    if(response.status!==200){
      const rate=response.status===429||response.headers.get('x-ratelimit-remaining')==='0';
      let cleanup='';try{await response.body?.cancel();}catch(error){cleanup=`; response cleanup failed (${transportCode(error)})`;}
      throw new UpdateProblem('service',`${rate?'GitHub runtime update rate limit':'Runtime update service refused request'} (HTTP ${response.status})${cleanup}`);
    }
    return response;
  }
  throw new UpdateProblem('rejected','Runtime redirect limit exceeded');
}
async function consume(url:string,policy:UpdatePolicy,signal:AbortSignal,maximum:number,deadline:number,write:(bytes:Uint8Array)=>Promise<void>,progress?:(bytes:number)=>void):Promise<number>{
  const idle=new AbortController(),bounded=AbortSignal.any([signal,AbortSignal.timeout(deadline),idle.signal]);let timer:ReturnType<typeof setTimeout>|undefined,total=0;
  const arm=(ms:number)=>{clearTimeout(timer);timer=setTimeout(()=>idle.abort(new DOMException(`No network progress for ${ms/1000}s`,'TimeoutError')),ms);};
  try{
    arm(policy.metadataDeadline);
    const response=await responseFor(url,policy,bounded,signal),size=response.headers.get('content-length');
    demand(size===null||(/^\d+$/.test(size)&&integer(Number(size),0,maximum)),'Runtime HTTP content length exceeds bound or is invalid');
    demand(response.body,'Runtime response body is missing');const reader=response.body.getReader();
    try{
      for(;;){
        // The former three-minute whole-file deadline killed healthy slow downloads.
        arm(Math.min(deadline,policy.payloadIdleDeadline));let chunk:ReadableStreamReadResult<Uint8Array>;
        try{chunk=await reader.read();}catch(error){
          if(signal.aborted)return transportProblem(error,signal);
          const timed=bounded.aborted&&bounded.reason?.name==='TimeoutError';
          throw new UpdateProblem(timed?'unavailable':'rejected',`Incomplete runtime transfer: download stopped after ${total} bytes (${transportCode(bounded.aborted?bounded.reason:error)}${idle.signal.aborted?'; '+idle.signal.reason.message:''}); no incomplete files will be installed`);
        }
        clearTimeout(timer);if(chunk.done)break;
        total+=chunk.value.byteLength;demand(total<=maximum,'Runtime response byte limit exceeded');await write(chunk.value);progress?.(total);
      }
      demand(size===null||Number(size)===total,'Incomplete runtime HTTP content length');return total;
    }catch(error){
      try{await reader.cancel();}catch(cleanup){if(error instanceof Error)error.message+=`; response cleanup failed (${transportCode(cleanup)})`;}
      throw error;
    }finally{reader.releaseLock();}
  }finally{clearTimeout(timer);idle.abort();}
}
export async function metadata(url:string,policy:UpdatePolicy,signal:AbortSignal,maximum=MAX_METADATA):Promise<Buffer>{
  const chunks:Buffer[]=[];await consume(url,policy,signal,maximum,policy.metadataDeadline,async bytes=>{chunks.push(Buffer.from(bytes));});return Buffer.concat(chunks);
}
export function assetURL(policy:UpdatePolicy,tag:string,name:string):string{
  demand(label(tag)&&/^runtime-(linux-x64|win32-x64|darwin-arm64)\.(?:json(?:\.sig)?|tar\.gz)$/.test(name),'Invalid fixed release asset name');
  return `${policy.assetOrigin}/${REPOSITORY}/releases/download/${tag}/${name}`;
}
export async function discover(policy:UpdatePolicy,signal:AbortSignal,remember?:(bytes:Buffer,signature:Buffer,sequence:number)=>Promise<void>):Promise<{release:Release;manifest:Manifest;bytes:Buffer;signature:Buffer}>{
  const value=decodeJson(await metadata(policy.discovery,policy,signal,1024*1024),1024*1024) as Record<string,unknown>;
  demand(value&&typeof value==='object'&&integer(value.id,1)&&label(value.tag_name)&&value.draft===false&&value.prerelease===false&&value.url===policy.discovery.replace(/\/latest$/,`/${value.id}`)&&Array.isArray(value.assets)&&value.assets.length<=64,'Invalid immutable GitHub runtime generation');
  const names=new Set<string>(),ids=new Set<number>();
  for(const item of value.assets){
    const a=item as Asset;demand(a&&typeof a==='object'&&integer(a.id,1)&&typeof a.name==='string'&&a.name.length<=255&&integer(a.size,0)&&typeof a.browser_download_url==='string'&&!names.has(a.name.toLowerCase())&&!ids.has(a.id),'Invalid/duplicate release asset');names.add(a.name.toLowerCase());ids.add(a.id);
  }
  const release=value as unknown as Release;
  const find=(name:string)=>{const asset=release.assets.find(a=>a.name===name);demand(asset&&asset.browser_download_url===assetURL(policy,release.tag_name,name),`Missing/mismatched generation asset: ${name}`);return asset;};
  const manifestAsset=find(`runtime-${policy.target}.json`),signatureAsset=find(`runtime-${policy.target}.json.sig`),payload=find(`runtime-${policy.target}.tar.gz`);
  demand(manifestAsset.size<=MAX_METADATA&&signatureAsset.size===64,'Invalid manifest/signature asset byte length');
  const parts=await Promise.allSettled([metadata(manifestAsset.browser_download_url,policy,signal),metadata(signatureAsset.browser_download_url,policy,signal,64)]);
  for(const part of parts)if(part.status==='rejected')throw part.reason;
  const [bytes,signature]=parts.map(part=>(part as PromiseFulfilledResult<Buffer>).value);
  demand(bytes.byteLength===manifestAsset.size&&signature.byteLength===signatureAsset.size,'Manifest/signature asset truncated or changed');
  const header=authenticateManifest(bytes,signature,policy.publicKey,release.id,release.tag_name);
  if(remember)await remember(bytes,signature,header.sequence);
  const manifest=verifyManifest(bytes,signature,policy.publicKey,release.id,release.tag_name,policy.target,policy.launcher,policy.assetOrigin);
  demand(manifest.payload.id===payload.id&&manifest.payload.name===payload.name&&manifest.payload.url===payload.browser_download_url&&manifest.payload.bytes===payload.size,'Signed payload does not belong to the resolved release generation');
  return{release,manifest,bytes,signature};
}
export async function downloadPayload(manifest:{payload:{url:string;bytes:number;sha256:string}},path:string,policy:UpdatePolicy,signal:AbortSignal,progress?:(bytes:number)=>void):Promise<void>{
  const output=await open(path,'wx',0o600),hash=createHash('sha256');
  try{
    const size=await consume(manifest.payload.url,policy,signal,manifest.payload.bytes,policy.payloadDeadline,async bytes=>{
      let offset=0;while(offset<bytes.byteLength){const{bytesWritten}=await output.write(bytes,offset,bytes.byteLength-offset);demand(bytesWritten>0,'Runtime staging write made no progress');offset+=bytesWritten;}hash.update(bytes);
    },progress);
    demand(size===manifest.payload.bytes&&hash.digest('hex')===manifest.payload.sha256,'Runtime payload digest/size mismatch or truncated download');await output.sync();
  }finally{await output.close();}
}
