import type * as FileSystem from 'node:fs';
// Electron virtualizes .asar as a directory; authentication must hash the actual archive bytes.
export const disk:typeof FileSystem=process.versions.electron?require('original-fs'):require('node:fs');
const {createReadStream,createWriteStream}=disk;
const {lstat,readdir,readlink,readFile,mkdir,chmod,open,symlink}=disk.promises;
import {join,posix,dirname} from 'node:path';
import {createHash,createPublicKey,verify} from 'node:crypto';
import {Parser,ReadEntry} from 'tar';
import {Transform,Writable,Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGunzip} from 'node:zlib';
import {Target,REPOSITORY,decodeJson,demand,exact,hex,integer,launcherVersion} from './update-format';
export const LAUNCHER_DOMAIN=Buffer.from('OpenRotMG launcher manifest v1\0');
export const LAUNCHER_METADATA_LIMIT=2*1024*1024;
export type LauncherEntry={path:string;type:'file'|'directory'|'symlink';mode:number;bytes?:number;sha256?:string;link?:string};
export type LauncherManifest={format:1;kind:'openrotmg-launcher';version:string;target:Target;bootstrap:1;source:string;payload:{name:string;url:string;bytes:number;sha256:string};files:LauncherEntry[]};
export const sha256=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export const launcherAsset=(target:Target,suffix:string)=>`launcher-${target}.${suffix}`;
export const launcherAssetURL=(version:string,target:Target,suffix:string)=>`https://github.com/${REPOSITORY}/releases/download/v${version}/${launcherAsset(target,suffix)}`;
export function launcherPath(path:string,target:Target){
 demand(typeof path==='string'&&path.length<=1024&&!/[\\\x00-\x1f:]/.test(path)&&path===path.normalize('NFC'),'Unsafe launcher path');
 demand(path==='bootstrap'||path==='bootstrap.exe'||path==='app'||path.startsWith('app/'),'Launcher file is outside its package');
 for(const part of path.split('/'))demand(part&&part!=='.'&&part!=='..'&&!/[ .]$/.test(part)&&(target!=='win32-x64'||!/[<>"|?*]/.test(part)&&!/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i.test(part)),'Unsafe launcher path component');
}
export function validateLauncherManifest(m:unknown,target:Target,version?:string):LauncherManifest{
 exact(m,'format,kind,version,target,bootstrap,source,payload,files','launcher manifest');const v=m as LauncherManifest;
 demand(v.format===1&&v.kind==='openrotmg-launcher'&&v.target===target&&v.bootstrap===1&&hex(v.source,40),'Unsupported launcher metadata/platform/bootstrap');launcherVersion(v.version);demand(!version||v.version===version,'Launcher version does not match its release');
 exact(v.payload,'name,url,bytes,sha256','launcher payload');demand(v.payload.name===launcherAsset(target,'tar.gz')&&v.payload.url===launcherAssetURL(v.version,target,'tar.gz')&&integer(v.payload.bytes,1,512*1024*1024)&&hex(v.payload.sha256),'Untrusted launcher payload');
 demand(Array.isArray(v.files)&&v.files.length>0&&v.files.length<=5000,'Launcher inventory exceeds bound');const entries=new Map<string,LauncherEntry>(),aliases=new Set<string>();let total=0;
 for(const e of v.files){launcherPath(e.path,target);demand(!aliases.has(e.path.toLowerCase()),'Duplicate/case-aliased launcher entry');aliases.add(e.path.toLowerCase());entries.set(e.path,e);demand([0o644,0o755,0o777].includes(e.mode),'Unsafe launcher mode');
  if(e.type==='file'){demand(e.mode===0o644||e.mode===0o755,'Unsafe launcher file mode');exact(e,'path,type,mode,bytes,sha256','launcher file');demand(integer(e.bytes,0,1024*1024*1024)&&hex(e.sha256),'Invalid launcher file');total+=e.bytes!;}
  else if(e.type==='directory'){demand(e.mode===0o755,'Unsafe launcher directory mode');exact(e,'path,type,mode','launcher directory');}
  else{exact(e,'path,type,mode,link','launcher link');demand(e.type==='symlink'&&e.mode===0o777&&typeof e.link==='string'&&e.link.length<=1024&&!/[\\\x00-\x1f:]/.test(e.link)&&!posix.isAbsolute(e.link),'Unsafe launcher symlink');const resolved=posix.normalize(posix.join(posix.dirname(e.path),e.link!));demand(resolved.startsWith('app/'),'Launcher symlink escapes application');}
 }
 demand(total>0&&total<=1024*1024*1024,'Expanded launcher exceeds bound');
 for(const e of v.files){let p=posix.dirname(e.path);while(p!=='.'){demand(entries.get(p)?.type==='directory','Launcher entry has missing/linked ancestor');p=posix.dirname(p);}}
 function resolveLink(parts:string[],depth=0):string{demand(depth<=32,'Cyclic launcher symlink');const resolved:string[]=[];for(let i=0;i<parts.length;i++){const part=parts[i];if(part==='.')continue;if(part==='..'){demand(resolved.length>1,'Launcher symlink chain escapes application');resolved.pop();continue;}resolved.push(part);demand(resolved[0]==='app','Launcher symlink chain escapes application');const entry=entries.get(resolved.join('/'));demand(entry,'Dangling launcher symlink');if(entry.type==='symlink')return resolveLink([...resolved.slice(0,-1),...entry.link!.split('/'),...parts.slice(i+1)],depth+1);demand(i===parts.length-1||entry.type==='directory','Launcher symlink traverses a file');}return resolved.join('/');}
 for(const e of v.files)if(e.type==='symlink')resolveLink(e.path.split('/'));
 const appBase=target==='darwin-arm64'?'app/Open RotMG Single Player.app/Contents/':'app/',engine=appBase+(target==='darwin-arm64'?'MacOS/openrotmg-single-player':target==='win32-x64'?'openrotmg-single-player.exe':'openrotmg-single-player'),asar=appBase+(target==='darwin-arm64'?'Resources/app.asar':'resources/app.asar');demand(entries.get(engine)?.type==='file'&&(target==='win32-x64'||entries.get(engine)!.mode&0o111),'Launcher engine missing or not executable');demand(entries.get(asar)?.type==='file','Launcher application archive missing');
 demand(entries.get(target==='win32-x64'?'bootstrap.exe':'bootstrap')?.type==='file'&&entries.get('app')?.type==='directory','Incomplete launcher package');return v;
}
export function authenticateLauncher(bytes:Buffer,signature:Buffer,key:string,target:Target,version?:string){
 demand(bytes.length<=LAUNCHER_METADATA_LIMIT&&signature.length===64,'Invalid launcher signature/metadata size');const publicKey=createPublicKey(key);demand(publicKey.asymmetricKeyType==='ed25519'&&verify(null,Buffer.concat([LAUNCHER_DOMAIN,bytes]),publicKey,signature),'Launcher signature is invalid');return validateLauncherManifest(decodeJson(bytes,LAUNCHER_METADATA_LIMIT),target,version);
}
export async function launcherInventory(root:string):Promise<LauncherEntry[]>{
 const result:LauncherEntry[]=[];async function visit(path:string){const full=join(root,path),s=await lstat(full);if(s.isDirectory()){result.push({path,type:'directory',mode:0o755});for(const name of (await readdir(full)).sort())await visit(path+'/'+name);}else if(s.isSymbolicLink())result.push({path,type:'symlink',mode:0o777,link:await readlink(full)});else{demand(s.isFile(),'Special launcher file rejected');result.push({path,type:'file',mode:s.mode&0o111?0o755:0o644,bytes:s.size,sha256:sha256(await readFile(full))});}}
 for(const name of (await readdir(root)).sort())await visit(name);return result;
}
export async function verifyLauncherTree(root:string,manifest:LauncherManifest){const actual=await launcherInventory(root);demand(JSON.stringify(actual)===JSON.stringify(manifest.files),'Launcher inventory, executable modes, links or file bytes changed');}
export async function extractLauncher(archive:string,destination:string,m:LauncherManifest){
 const expected=new Map(m.files.map(e=>[e.path,e])),seen=new Set<string>();let expanded=0;const expectedBytes=m.files.reduce((n,e)=>n+(e.bytes??0),0);
 const inspect=(e:ReadEntry)=>{const path=e.path.replace(/\/$/,'');launcherPath(path,m.target);const item=expected.get(path);demand(item&&!seen.has(path)&&!e.extended&&!e.globalExtended&&e.path===e.header.path,'Unexpected/extended launcher archive entry');seen.add(path);demand((e.mode??0)===item.mode,'Launcher archive mode mismatch');demand((item.type==='file'&&e.type==='File'&&e.size===item.bytes&&!e.linkpath)||(item.type==='directory'&&e.type==='Directory'&&e.size===0&&!e.linkpath)||(item.type==='symlink'&&e.type==='SymbolicLink'&&e.linkpath===item.link&&e.size===0),'Launcher archive type/link/size mismatch');expanded+=e.size;demand(expanded<=expectedBytes,'Expanded launcher exceeds its inventory');};
 const parse=new Parser({strict:true,filter:(_p,e)=>{try{demand(e instanceof ReadEntry,'Invalid launcher archive entry');inspect(e);return true;}catch(error){parse.abort(error as Error);return false;}}});parse.on('entry',e=>e.resume());parse.on('meta',()=>parse.abort(Error('Extended launcher archive headers rejected')));parse.on('ignoredEntry',()=>parse.abort(Error('Special launcher archive entry rejected')));
 const run=async(s:Parser)=>{let bytes=0;const bound=new Transform({transform(chunk,_e,cb){bytes+=chunk.length;cb(bytes>expectedBytes+1024*(m.files.length+8)?Error('Launcher decompression limit exceeded'):null,chunk);}});await pipeline(createReadStream(archive),createGunzip(),bound,s as unknown as Writable);};
 await run(parse);demand(seen.size===expected.size&&expanded===expectedBytes,'Incomplete launcher archive');await mkdir(destination,{mode:0o700});
 seen.clear();expanded=0;
 const unpack=new Parser({strict:true,filter:(_p,e)=>{try{demand(e instanceof ReadEntry,'Unexpected launcher extraction entry');inspect(e);return true;}catch(error){unpack.abort(error as Error);return false;}}});
 const writes:Promise<void>[]=[],active=new Set<ReadEntry>();let writeError:unknown;
 unpack.on('entry',entry=>{active.add(entry);const item=expected.get(entry.path.replace(/\/$/,''))!,path=join(destination,item.path);const task=(async()=>{await mkdir(dirname(path),{recursive:true,mode:0o700});if(item.type==='directory')await mkdir(path,{recursive:true,mode:0o700});else if(item.type==='symlink')await symlink(item.link!,path);else await pipeline(entry as unknown as Readable,createWriteStream(path,{flags:'wx',mode:0o600}));if(item.type!=='file')entry.resume();})().catch(error=>{if(!writeError){writeError=error;unpack.abort(error as Error);}}).finally(()=>active.delete(entry));writes.push(task);});
 unpack.on('meta',()=>unpack.abort(Error('Launcher archive changed after inspection')));unpack.on('ignoredEntry',()=>unpack.abort(Error('Special launcher extraction entry rejected')));
 try{await run(unpack);}catch(error){writeError??=error;for(const entry of active)entry.destroy();throw error;}finally{await Promise.all(writes);}if(writeError)throw writeError;demand(seen.size===expected.size&&expanded===expectedBytes,'Launcher archive changed after inspection');
 for(const e of m.files)if(e.type!=='symlink'){await chmod(join(destination,e.path),e.mode);if(e.type==='file'){const f=await open(join(destination,e.path),'r+');try{await f.sync();}finally{await f.close();}}}
 if(process.platform!=='win32')for(const e of [...m.files].reverse().filter(e=>e.type==='directory')){const f=await open(join(destination,e.path),'r');try{await f.sync();}finally{await f.close();}}
 await verifyLauncherTree(destination,m);
}
