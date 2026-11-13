import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {lstat,open,realpath} from 'node:fs/promises';
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path';
import {decodeJson,demand,exact,portablePath} from './update-format';
import {serverCommandPath} from './runtime';

export type MetadataOperation='publish-replace'|'publish-distinct'|'move-distinct'|'create-container';
export type MetadataRequest={operation:MetadataOperation;root:string;source:string|null;destination:string;kind:'file'|'directory'};
export class MetadataPublicationError extends Error{constructor(message:string){super(message);this.name='MetadataPublicationError';}}
export function metadataAcknowledgement(data:Buffer,request:MetadataRequest,pid:number){
  demand(data.length>0&&data.length<=16384&&data.at(-1)===10,'Metadata acknowledgement must be bounded UTF-8 JSON plus newline');
  const ack=decodeJson(data,16384);exact(ack,'protocol,operation,process,root,source,destination,kind,published','native metadata acknowledgement');
  demand(ack.protocol===1&&ack.operation===request.operation&&ack.process===pid&&Number.isSafeInteger(pid)&&pid>0&&ack.root===request.root&&ack.source===request.source&&ack.destination===request.destination&&ack.kind===request.kind&&ack.published===true,'Native metadata acknowledgement does not match the owned publication');
}
export async function publishMetadata(binary:string,request:MetadataRequest){
  demand(isAbsolute(binary)&&isAbsolute(request.root),'Metadata binary/root must be absolute');portablePath(request.destination);if(request.source!==null)portablePath(request.source);
  const args=['--desktop-metadata',request.operation,request.root,...(request.source===null?[]:[request.source]),request.destination],env:NodeJS.ProcessEnv={};
  for(const key of ['SystemRoot','WINDIR','TEMP','TMP','HOME','USERPROFILE','LANG'])if(process.env[key])env[key]=process.env[key];
  const child=spawn(serverCommandPath(binary),args,{windowsHide:true,env,stdio:['ignore','pipe','pipe']});let output=Buffer.alloc(0),stderr=0,overflow=false,spawnError:Error|undefined,transportError=false;
  child.stdout.on('data',(data:Buffer)=>{if(output.length+data.length>16384)overflow=true;output=Buffer.concat([output,data.subarray(0,Math.max(0,16384-output.length))]);});
  child.stderr.on('data',(data:Buffer)=>{stderr+=data.length;if(stderr>16384)overflow=true;});child.once('error',error=>{spawnError=error;});child.stdout.on('error',()=>{transportError=true;});child.stderr.on('error',()=>{transportError=true;});
  const closed=await new Promise<{code:number|null;signal:string|null}>(ok=>child.once('close',(code,signal)=>ok({code,signal})));
  demand(!spawnError&&closed.code===0&&closed.signal===null&&!overflow&&!transportError&&stderr===0,`Native metadata publication completion UNKNOWN: exit=${closed.code}, signal=${closed.signal}, overflow=${overflow}, transport=${transportError}, spawn=${!!spawnError}, stderrBytes=${stderr}`);
  metadataAcknowledgement(output,request,child.pid!);
}
export class WindowsMetadataPublication{
  private failure?:MetadataPublicationError;
  get unknown(){return this.failure!==undefined;}
  private blocked(error:unknown){if(!this.failure){this.failure=new MetadataPublicationError(`Windows metadata publication UNKNOWN; no replay or filesystem fallback: ${String(error)}`);this.fault(this.failure);}return this.failure;}
  constructor(readonly root:string,private binary:()=>Promise<string>,private fault:(error:Error)=>void){}
  reject(error:unknown):never{throw this.blocked(error);}
  private name(path:string){const name=relative(this.root,path).split(sep).join('/');portablePath(name);demand(!name.startsWith('../')&&name!==''&&resolve(this.root,name)===resolve(path),'Metadata publication escaped its existing root');return name;}
  private async perform(operation:MetadataOperation,source:string|null,destination:string,kind:'file'|'directory'){
    if(this.failure)throw this.failure;
    try{await publishMetadata(await this.binary(),{operation,root:this.root,source:source===null?null:this.name(source),destination:this.name(destination),kind});}
    catch(error){throw this.blocked(error);}
  }
  async rootExists(){const info=await lstat(this.root);demand(info.isDirectory()&&!info.isSymbolicLink()&&await realpath(this.root)===this.root,'Metadata ROOT must be an existing resolved Electron userData directory');}
  async prepare(){if(this.failure)throw this.failure;try{await this.rootExists();await this.binary();}catch(error){throw this.blocked(error);}}
  async container(path:string){
    await this.prepare();this.name(path);try{const info=await lstat(path);demand(info.isDirectory()&&!info.isSymbolicLink(),'Metadata container is not a regular directory');return;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(dirname(path)!==this.root)await this.container(dirname(path));await this.perform('create-container',null,path,'directory');
  }
  async bytes(path:string,bytes:Uint8Array,distinct:boolean){
    if(this.failure)throw this.failure;
    await this.prepare();const temporary=`${path}.partial-${randomUUID()}`;
    try{const file=await open(temporary,'wx',0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}}
    catch(error){throw this.blocked(`File staging failed before publication: ${String(error)}`);}
    // A failed native ACK may follow a consumed staging move; neither pathname is cleanup permission.
    await this.perform(distinct?'publish-distinct':'publish-replace',temporary,path,'file');
  }
  async move(source:string,destination:string,kind:'file'|'directory'){await this.prepare();await this.perform('move-distinct',source,destination,kind);}
}
