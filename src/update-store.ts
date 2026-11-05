import {randomUUID} from 'node:crypto';
import {chmod,cp,link,lstat,mkdir,mkdtemp,open,readdir,rename,rm,stat,unlink} from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';
import {authenticateManifest,boundedFile,BuildIdentity,decodeJson,demand,digest,exact,hex,integer,label,Manifest,MAX_METADATA,portablePath,Target,validatePins,verifyCapabilities,verifyManifest,verifyRuntime} from './update-format';
import {UpdatePolicy} from './update-policy';

export type Generation={format:1;id:string;kind:'source'|'release';target:Target;sequence:number;version:string;startupBackup:0|1;clientNamespace:0|1;identitySha256:string;manifestSha256:string|null;pins:BuildIdentity['pins'];assetsSha256:string;binarySha256:string};
export type Selection={format:1;id:string;descriptorSha256:string};
export type Profile={format:1;baseline:Selection;initialized:boolean;attempts:{id:string;sequence:number}[];failed:string[]};
export async function exists(path:string){try{await stat(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
export {boundedFile} from './update-format';
export async function record(path:string):Promise<unknown>{return decodeJson(await boundedFile(path),4*1024*1024);}
export async function syncDirectory(path:string){
  // Windows exposes file FlushFileBuffers, but not POSIX directory fsync; match the Rust snapshot publication contract.
  if(process.platform==='win32')return;
  const directory=await open(path,'r');try{await directory.sync();}finally{await directory.close();}
}
export async function durableBytes(path:string,bytes:Uint8Array,distinct=false):Promise<void>{
  const temporary=`${path}.partial-${randomUUID()}`;let created=false,published=false,primary:unknown;
  try{
    const file=await open(temporary,'wx',0o600);created=true;
    try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
    if(distinct){await link(temporary,path);await unlink(temporary);}else await rename(temporary,path);
    published=true;await syncDirectory(dirname(path));
    const publishedFile=await open(path,'r+');try{await publishedFile.sync();}finally{await publishedFile.close();}
  }catch(error){primary=error;throw error;}
  finally{if(created&&!published){try{await unlink(temporary);}catch(cleanup){if((cleanup as NodeJS.ErrnoException).code!=='ENOENT')throw new Error(`Runtime record publication failed: ${String(primary)}; temporary cleanup failed: ${String(cleanup)}`);}}}
}
export const durableRecord=(path:string,value:unknown,distinct=false)=>durableBytes(path,Buffer.from(JSON.stringify(value,null,2)+'\n'),distinct);
export function selection(value:unknown):Selection{
  exact(value,'format,id,descriptorSha256','runtime selection');demand(value.format===1&&typeof value.id==='string'&&/^(source-[a-f0-9]{64}|release-[1-9]\d{0,15}-[a-f0-9]{64})$/.test(value.id)&&hex(value.descriptorSha256),'Invalid authoritative runtime selection');return value as unknown as Selection;
}
export function generation(identity:BuildIdentity,identitySha256:string,target:Target,startupBackup:0|1,clientNamespace:0|1,manifest?:Manifest,manifestSha256?:string):Generation{
  if(manifest){demand(hex(manifestSha256),'Missing authenticated manifest identity');return{format:1,id:`release-${manifest.sequence}-${manifestSha256}`,kind:'release',target,sequence:manifest.sequence,version:manifest.version,startupBackup:1,clientNamespace:1,identitySha256,manifestSha256,pins:manifest.pins,assetsSha256:identity.assetsSha256,binarySha256:identity.binarySha256};}
  return{format:1,id:`source-${identitySha256}`,kind:'source',target,sequence:0,version:`source-${identity.pins.server.commit.slice(0,12)}-${identity.pins.client.commit.slice(0,12)}`,startupBackup,clientNamespace,identitySha256,manifestSha256:null,pins:identity.pins,assetsSha256:identity.assetsSha256,binarySha256:identity.binarySha256};
}
export const select=(g:Generation):Selection=>({format:1,id:g.id,descriptorSha256:digest(JSON.stringify(g))});
export class RuntimeStore{
  readonly generations:string;readonly staging:string;
  constructor(readonly userData:string,readonly policy:UpdatePolicy){this.generations=join(userData,'runtimes');this.staging=join(userData,'runtime-staging');}
  path(name:string){portablePath(name);demand(!name.includes('/'),'Runtime control name must not be a path');return join(this.userData,name);}
  root(id:string){selection({format:1,id,descriptorSha256:'0'.repeat(64)});return join(this.generations,id,'runtime');}
  async profile():Promise<Profile>{
    const p=await record(this.path('runtime-profile.json'));exact(p,'format,baseline,initialized,attempts,failed','runtime profile');selection(p.baseline);
    demand(p.format===1&&typeof p.initialized==='boolean'&&Array.isArray(p.attempts)&&p.attempts.length<=10_000&&Array.isArray(p.failed)&&p.failed.length<=10_000,'Invalid runtime bootstrap/history');
    const ids=new Set<string>();for(const a of p.attempts){exact(a,'id,sequence','runtime attempt');demand(integer(a.sequence,1)&&typeof a.id==='string'&&a.id.startsWith(`release-${a.sequence}-`)&&!ids.has(a.id),'Invalid runtime attempt history');selection({format:1,id:a.id,descriptorSha256:'0'.repeat(64)});ids.add(a.id);}
    demand(new Set(p.failed).size===p.failed.length&&p.failed.every(id=>typeof id==='string'&&ids.has(id)),'Invalid failed-runtime history');return p as unknown as Profile;
  }
  async initialize():Promise<{profile:Profile;selected:Generation}>{
    await mkdir(this.userData,{recursive:true,mode:0o700});
    let p:Profile;
    if(!await exists(this.path('runtime-profile.json'))){
      for(const name of ['runtime-selection.json','runtime-pending.json','runtime-recovery.json','runtime-activity.json','runtime-check-refusal.json','runtimes','runtime-staging','runtime-manifests','runtime-recovery-history'])demand(!await exists(this.path(name)),'Managed runtime state exists but bootstrap anchor is missing; recovery required');
      const baseline=await this.bundled();p={format:1,baseline:select(baseline),initialized:false,attempts:[],failed:[]};
      await durableRecord(this.path('runtime-profile.json'),p,true);
    }else p=await this.profile();
    if(!p.initialized){
      let baseline:Generation;
      if(await exists(join(this.generations,p.baseline.id)))baseline=await this.load(p.baseline);
      else{
        baseline=await this.bundled();demand(JSON.stringify(select(baseline))===JSON.stringify(p.baseline),'Interrupted bootstrap belongs to a different installer; no baseline substitution is allowed');
        const stage=await this.stage();
        try{await cp(this.policy.baseline.root,join(stage,'runtime'),{recursive:true,errorOnExist:true,force:false});
          if(this.policy.baseline.mode==='release'){demand(this.policy.baseline.manifest&&this.policy.baseline.signature,'Release baseline signature missing');await durableBytes(join(stage,'manifest.json'),this.policy.baseline.manifest);await durableBytes(join(stage,'manifest.sig'),this.policy.baseline.signature);}
          await this.publish(stage,baseline);
        }catch(error){await this.cleanup(stage,error);throw error;}
      }
      if(await exists(this.path('runtime-selection.json')))demand(JSON.stringify(selection(await record(this.path('runtime-selection.json'))))===JSON.stringify(p.baseline),'Interrupted bootstrap selection mismatch');
      else await this.choose(baseline);
      p={...p,initialized:true};await durableRecord(this.path('runtime-profile.json'),p);
    }
    const selected=await this.load(selection(await record(this.path('runtime-selection.json'))));return{profile:p,selected};
  }
  async bundled():Promise<Generation>{
    const baseline=this.policy.baseline,identityBytes=await boundedFile(join(baseline.root,'build-identity.json'),MAX_METADATA);
    demand(digest(identityBytes)===baseline.identitySha256,'Installed baseline identity differs from its explicit launcher declaration');
    let manifest:Manifest|undefined;
    if(baseline.mode==='release'){demand(baseline.manifest&&baseline.signature,'Release baseline metadata/signature missing');manifest=verifyManifest(baseline.manifest,baseline.signature,this.policy.publicKey,undefined,undefined,this.policy.target,this.policy.launcher,this.policy.assetOrigin);}
    else demand(baseline.mode==='source'&&!baseline.manifest&&!baseline.signature,'Invalid explicit source-build baseline');
    const identity=await verifyRuntime(baseline.root,this.policy.target,manifest);await verifyCapabilities(baseline.root,identity.pins,baseline.startupBackup,baseline.clientNamespace);
    return generation(identity,baseline.identitySha256,this.policy.target,baseline.startupBackup,baseline.clientNamespace,manifest,baseline.manifest?digest(baseline.manifest):undefined);
  }
  async stage(){await mkdir(this.staging,{recursive:true,mode:0o700});return mkdtemp(join(this.staging,'generation-'));}
  async remember(bytes:Uint8Array,signature:Uint8Array,manifest:Pick<Manifest,'sequence'>){
    const directory=join(this.userData,'runtime-manifests');await mkdir(directory,{recursive:true,mode:0o700});
    const prefix=`${manifest.sequence}-`,sha=digest(bytes);
    for(const name of await readdir(directory))if(name.startsWith(prefix)&&name.endsWith('.json'))demand(name===`${prefix}${sha}.json`,'Same authenticated sequence has a different manifest identity; refusing replacement');
    const path=join(directory,`${prefix}${sha}.json`);
    if(await exists(path))demand(digest(await boundedFile(path,MAX_METADATA))===sha,'Remembered manifest is corrupt');else await durableBytes(path,bytes,true);
    const sig=join(directory,`${prefix}${sha}.sig`);if(await exists(sig))demand((await boundedFile(sig,64)).equals(Buffer.from(signature)),'Remembered signature is corrupt');else await durableBytes(sig,signature,true);
  }
  async authenticatedFloor():Promise<number>{
    const directory=join(this.userData,'runtime-manifests');if(!await exists(directory))return 0;
    const names=await readdir(directory);demand(names.length<=20_000,'Authenticated manifest history exceeds bound');const entries=new Set(names);let floor=0;
    for(const name of names){
      demand(/^[1-9][0-9]*-[a-f0-9]{64}\.(json|sig)$/.test(name),'Unexpected authenticated manifest history entry');
      const stem=name.replace(/\.(json|sig)$/,'');demand(entries.has(stem+'.json')&&entries.has(stem+'.sig'),'Authenticated manifest history is incomplete; refusing rollback');
      if(name.endsWith('.json')){
        const data=await boundedFile(join(directory,name),MAX_METADATA),signature=await boundedFile(join(directory,stem+'.sig'),64),header=authenticateManifest(data,signature,this.policy.publicKey);
        demand(stem===`${header.sequence}-${digest(data)}`,'Authenticated manifest history identity changed');floor=Math.max(floor,header.sequence);
      }
    }
    return floor;
  }
  async load(value:Selection):Promise<Generation>{
    const s=selection(value),directory=join(this.generations,s.id),g=await record(join(directory,'generation.json'));
    exact(g,'format,id,kind,target,sequence,version,startupBackup,clientNamespace,identitySha256,manifestSha256,pins,assetsSha256,binarySha256','runtime generation');validatePins(g.pins);
    demand(g.format===1&&g.id===s.id&&g.target===this.policy.target&&integer(g.sequence,0)&&(g.startupBackup===0||g.startupBackup===1)&&(g.clientNamespace===0||g.clientNamespace===1)&&label(g.version)&&hex(g.identitySha256)&&hex(g.assetsSha256)&&hex(g.binarySha256)&&digest(JSON.stringify(g))===s.descriptorSha256,'Selected runtime descriptor is corrupt/mismatched');
    let manifest:Manifest|undefined,bytes:Buffer|undefined;
    if(g.kind==='release'){
      bytes=await boundedFile(join(directory,'manifest.json'),MAX_METADATA);const signature=await boundedFile(join(directory,'manifest.sig'),64);
      manifest=verifyManifest(bytes,signature,this.policy.publicKey,undefined,undefined,this.policy.target,this.policy.launcher,this.policy.assetOrigin);demand(digest(bytes)===g.manifestSha256,'Selected runtime manifest changed');
    }else demand(g.kind==='source'&&g.sequence===0&&g.manifestSha256===null,'Invalid source/release generation distinction');
    const identity=await verifyRuntime(this.root(s.id),this.policy.target,manifest),identitySha=digest(await boundedFile(join(this.root(s.id),'build-identity.json'),MAX_METADATA));
    await verifyCapabilities(this.root(s.id),identity.pins,g.startupBackup as 0|1,g.clientNamespace as 0|1);
    const derived=generation(identity,identitySha,this.policy.target,g.startupBackup as 0|1,g.clientNamespace as 0|1,manifest,bytes?digest(bytes):undefined);
    demand(JSON.stringify(derived)===JSON.stringify(g),'Selected runtime generation does not match its immutable bytes');
    if(g.kind==='source'){const p=await this.profile();demand(JSON.stringify(s)===JSON.stringify(p.baseline),'Source selection is not the original anchored baseline');}
    return derived;
  }
  async publish(stage:string,g:Generation){
    await verifyRuntime(join(stage,'runtime'),this.policy.target,g.kind==='release'?verifyManifest(await boundedFile(join(stage,'manifest.json'),MAX_METADATA),await boundedFile(join(stage,'manifest.sig'),64),this.policy.publicKey,undefined,undefined,this.policy.target,this.policy.launcher,this.policy.assetOrigin):undefined);
    demand(digest(await boundedFile(join(stage,'runtime','build-identity.json'),MAX_METADATA))===g.identitySha256,'Staged generation identity mismatch');
    await durableRecord(join(stage,'generation.json'),g,true);await mkdir(this.generations,{recursive:true,mode:0o700});
    const freeze=async(path:string)=>{const info=await stat(path);if(info.isDirectory()){for(const name of await readdir(path))await freeze(join(path,name));if(path!==stage)await chmod(path,0o500);}else{await chmod(path,0o600);const handle=await open(path,'r+');try{await handle.sync();}finally{await handle.close();}await chmod(path,path===join(stage,'runtime',this.policy.target==='win32-x64'?'openrotmg.exe':'openrotmg')?0o500:0o400);}};
    // A cross-parent directory rename must update ".." before its root becomes read-only.
    await freeze(stage);await syncDirectory(stage);const published=join(this.generations,g.id);await rename(stage,published);await chmod(published,0o500);await syncDirectory(published);await syncDirectory(this.generations);
  }
  choose(g:Generation){return durableRecord(this.path('runtime-selection.json'),select(g));}
  async cleanup(stage:string,primary?:unknown){
    demand(dirname(stage)===this.staging&&/^generation-[A-Za-z0-9]+$/.test(basename(stage)),'Refusing cleanup outside an owned staging generation');
    const writable=async(path:string)=>{const info=await lstat(path);if(info.isDirectory()){await chmod(path,0o700);for(const name of await readdir(path))await writable(join(path,name));}else if(info.isFile())await chmod(path,0o600);};
    try{if(await exists(stage)){await writable(stage);await rm(stage,{recursive:true});}}
    catch(error){throw new Error(`${primary===undefined?'':`Primary update failure: ${String(primary)}. `}Owned runtime staging cleanup failed: ${String(error)}`);}
  }
}
