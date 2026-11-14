import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {demand, integer, MAX_METADATA} from './update-format';
import {UpdatePolicy} from './update-policy';

function transportCode(error:unknown):string{
  const e=error as {name?:unknown;cause?:{code?:unknown};code?:unknown};
  const code=e?.cause?.code??e?.code;
  return typeof code==='string'&&/^[A-Z0-9_]{1,60}$/.test(code)?code:typeof e?.name==='string'&&/^[A-Za-z]{1,40}$/.test(e.name)?e.name:'unclassified transport error';
}
function transportProblem(error:unknown,signal:AbortSignal):never{
  if(signal.aborted)throw new Error('Launcher update check canceled; no update success is claimed');
  const code=transportCode(error);
  throw new Error(`Could not reach the launcher update service (${code})`);
}
function checkedURL(url:string,policy:UpdatePolicy):URL{
  const parsed=new URL(url);
  demand(policy.redirectOrigins.includes(parsed.origin)&&!parsed.username&&!parsed.password&&!parsed.hash,'Untrusted launcher update origin/credentials/fragment');
  return parsed;
}
async function responseFor(url:string,policy:UpdatePolicy,signal:AbortSignal,canceled:AbortSignal):Promise<Response>{
  const initial=checkedURL(url,policy);let current=initial;
  for(let redirects=0;redirects<=4;redirects++){
    let response:Response;
    try{response=await policy.request(current,{redirect:'manual',signal,headers:{Accept:'application/octet-stream','Accept-Encoding':'identity','User-Agent':'OpenRotMG-Single-Player'}});}
    catch(error){return transportProblem(signal.aborted?signal.reason:error,canceled);}
    demand(!response.redirected,'Uncontrolled launcher redirect');
    if([301,302,303,307,308].includes(response.status)){
      const location=response.headers.get('location');
      try{await response.body?.cancel();}catch(error){throw new Error(`Launcher redirect HTTP ${response.status}; response cleanup failed (${transportCode(error)})`);}
      demand(location&&redirects<4,'Missing launcher redirect location or redirect limit exceeded');
      current=checkedURL(new URL(location,current).href,policy);
      if(current.origin===policy.assetOrigin||current.origin===initial.origin)demand(current.pathname===initial.pathname&&!current.search,'Launcher redirect changed the fixed repository/generation asset path');
      continue;
    }
    if(response.status!==200){
      const rate=response.status===429||response.headers.get('x-ratelimit-remaining')==='0';
      let cleanup='';try{await response.body?.cancel();}catch(error){cleanup=`; response cleanup failed (${transportCode(error)})`;}
      throw new Error(`${rate?'GitHub launcher update rate limit':'Launcher update service refused request'} (HTTP ${response.status})${cleanup}`);
    }
    return response;
  }
  throw new Error('Launcher redirect limit exceeded');
}
async function consume(url:string,policy:UpdatePolicy,signal:AbortSignal,maximum:number,deadline:number,write:(bytes:Uint8Array)=>Promise<void>,progress?:(bytes:number)=>void):Promise<number>{
  const idle=new AbortController(),bounded=AbortSignal.any([signal,AbortSignal.timeout(deadline),idle.signal]);let timer:ReturnType<typeof setTimeout>|undefined,total=0;
  const arm=(ms:number)=>{clearTimeout(timer);timer=setTimeout(()=>idle.abort(new DOMException(`No network progress for ${ms/1000}s`,'TimeoutError')),ms);};
  try{
    arm(policy.metadataDeadline);
    const response=await responseFor(url,policy,bounded,signal),size=response.headers.get('content-length');
    demand(size===null||(/^\d+$/.test(size)&&integer(Number(size),0,maximum)),'Launcher HTTP content length exceeds bound or is invalid');
    demand(response.body,'Launcher response body is missing');const reader=response.body.getReader();
    try{
      for(;;){
        // The former three-minute whole-file deadline killed healthy slow downloads.
        arm(Math.min(deadline,policy.payloadIdleDeadline));let chunk:ReadableStreamReadResult<Uint8Array>;
        try{chunk=await reader.read();}catch(error){
          if(signal.aborted)return transportProblem(error,signal);
          const timed=bounded.aborted&&bounded.reason?.name==='TimeoutError';
          throw new Error(`Incomplete launcher transfer: download stopped after ${total} bytes (${transportCode(bounded.aborted?bounded.reason:error)}${idle.signal.aborted?'; '+idle.signal.reason.message:''}); no incomplete files will be installed`);
        }
        clearTimeout(timer);if(chunk.done)break;
        total+=chunk.value.byteLength;demand(total<=maximum,'Launcher response byte limit exceeded');await write(chunk.value);progress?.(total);
      }
      demand(size===null||Number(size)===total,'Incomplete launcher HTTP content length');return total;
    }catch(error){
      try{await reader.cancel();}catch(cleanup){if(error instanceof Error)error.message+=`; response cleanup failed (${transportCode(cleanup)})`;}
      throw error;
    }finally{reader.releaseLock();}
  }finally{clearTimeout(timer);idle.abort();}
}
export async function metadata(url:string,policy:UpdatePolicy,signal:AbortSignal,maximum=MAX_METADATA):Promise<Buffer>{
  const chunks:Buffer[]=[];await consume(url,policy,signal,maximum,policy.metadataDeadline,async bytes=>{chunks.push(Buffer.from(bytes));});return Buffer.concat(chunks);
}
export async function downloadPayload(manifest:{payload:{url:string;bytes:number;sha256:string}},path:string,policy:UpdatePolicy,signal:AbortSignal,progress?:(bytes:number)=>void):Promise<void>{
  const output=await open(path,'wx',0o600),hash=createHash('sha256');
  try{
    const size=await consume(manifest.payload.url,policy,signal,manifest.payload.bytes,policy.payloadDeadline,async bytes=>{
      let offset=0;while(offset<bytes.byteLength){const{bytesWritten}=await output.write(bytes,offset,bytes.byteLength-offset);demand(bytesWritten>0,'Launcher staging write made no progress');offset+=bytesWritten;}hash.update(bytes);
    },progress);
    demand(size===manifest.payload.bytes&&hash.digest('hex')===manifest.payload.sha256,'Launcher payload digest/size mismatch or truncated download');await output.sync();
  }finally{await output.close();}
}
