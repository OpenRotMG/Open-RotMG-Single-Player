import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {demand, MAX_METADATA} from './update-format';
import {UpdatePolicy} from './update-policy';

const code=(error:unknown)=>{const e=error as {name?:string;cause?:{code?:string};code?:string};return e?.cause?.code??e?.code??e?.name??'unknown error';};
async function request(url:string,policy:UpdatePolicy,signal:AbortSignal):Promise<Response>{
  let current=new URL(url);
  for(let redirects=0;;redirects++){
    demand(policy.redirectOrigins.includes(current.origin)&&!current.username&&!current.password,'Untrusted update origin '+current.origin);
    const response=await policy.request(current,{redirect:'manual',signal,headers:{Accept:'application/octet-stream','Accept-Encoding':'identity','User-Agent':'OpenRotMG-Single-Player'}}).catch(error=>{throw new Error(`Could not reach the update service (${code(signal.reason??error)})`,{cause:error});});
    if(![301,302,303,307,308].includes(response.status)){
      if(response.status===200)return response;
      await response.body?.cancel();throw new Error(`Update service returned HTTP ${response.status}`);
    }
    await response.body?.cancel();const location=response.headers.get('location');
    demand(location&&redirects<4,'Missing update redirect or too many redirects');current=new URL(location,current);
  }
}
/** Streams one response, failing on the total deadline or after the idle deadline passes without data. */
async function consume(url:string,policy:UpdatePolicy,signal:AbortSignal,maximum:number,deadline:number,write:(bytes:Uint8Array)=>Promise<void>,progress?:(bytes:number)=>void):Promise<number>{
  const idle=new AbortController(),bounded=AbortSignal.any([signal,AbortSignal.timeout(deadline),idle.signal]);let timer:ReturnType<typeof setTimeout>|undefined,total=0;
  const arm=(ms:number)=>{clearTimeout(timer);timer=setTimeout(()=>idle.abort(new DOMException(`No network progress for ${ms/1000}s`,'TimeoutError')),ms);};
  try{
    arm(policy.metadataDeadline);
    const response=await request(url,policy,bounded),size=response.headers.get('content-length');
    demand(size===null||Number(size)<=maximum,'Update download is larger than expected');demand(response.body,'Update response has no body');
    const reader=response.body.getReader();
    try{
      for(;;){
        arm(Math.min(deadline,policy.payloadIdleDeadline));
        const chunk=await reader.read().catch(error=>{throw new Error(`Download stopped after ${total} bytes (${code(bounded.reason??error)})`,{cause:error});});
        if(chunk.done)break;
        total+=chunk.value.byteLength;demand(total<=maximum,'Update download is larger than expected');await write(chunk.value);progress?.(total);
      }
      demand(size===null||Number(size)===total,'Incomplete update download');return total;
    }catch(error){await reader.cancel().catch(()=>undefined);throw error;}
  }finally{clearTimeout(timer);idle.abort();}
}
export async function metadata(url:string,policy:UpdatePolicy,signal:AbortSignal,maximum=MAX_METADATA):Promise<Buffer>{
  const chunks:Buffer[]=[];await consume(url,policy,signal,maximum,policy.metadataDeadline,async bytes=>{chunks.push(Buffer.from(bytes));});return Buffer.concat(chunks);
}
export async function downloadPayload(manifest:{payload:{url:string;bytes:number;sha256:string}},path:string,policy:UpdatePolicy,signal:AbortSignal,progress?:(bytes:number)=>void):Promise<void>{
  const output=await open(path,'wx',0o600),hash=createHash('sha256');
  try{
    const size=await consume(manifest.payload.url,policy,signal,manifest.payload.bytes,policy.payloadDeadline,async bytes=>{await output.appendFile(bytes);hash.update(bytes);},progress);
    demand(size===manifest.payload.bytes&&hash.digest('hex')===manifest.payload.sha256,'Update download does not match its signed size and digest');await output.sync();
  }finally{await output.close();}
}
