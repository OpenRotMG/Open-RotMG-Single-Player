import {mkdir,cp,copyFile,readFile,writeFile,open} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createWriteStream,createReadStream} from 'node:fs';
import {createGzip} from 'node:zlib';
import {Header} from 'tar';
const require=createRequire(import.meta.url),{launcherInventory,validateLauncherManifest,sha256,launcherAsset,launcherAssetURL}=require('../dist/launcher-package.js');
export async function launcherBundle({packageDir,launcher,output,version,target,source,stage}){
 const payload=stage;await mkdir(payload);await cp(packageDir,join(payload,'app'),{recursive:true,verbatimSymlinks:true});await copyFile(launcher,join(payload,target==='win32-x64'?'bootstrap.exe':'bootstrap'));const files=await launcherInventory(payload),archive=join(output,launcherAsset(target,'tar.gz'));
 async function* entries(){for(const e of files){const header=new Header({path:e.type==='directory'?e.path+'/':e.path,type:e.type==='file'?'File':e.type==='directory'?'Directory':'SymbolicLink',mode:e.mode,size:e.bytes??0,linkpath:e.link??'',mtime:new Date(0),uid:0,gid:0,uname:'',gname:''});if(header.encode())throw Error('Launcher path needs an unsupported extended tar header: '+e.path);yield header.block;if(e.type==='file'){for await(const bytes of createReadStream(join(payload,e.path)))yield bytes;const pad=(512-(e.bytes%512))%512;if(pad)yield Buffer.alloc(pad);}}yield Buffer.alloc(1024);}
 await pipeline(Readable.from(entries()),createGzip({level:6}),createWriteStream(archive,{flags:'wx',mode:0o600}));const bytes=await readFile(archive);const manifest={format:1,kind:'openrotmg-launcher',version,target,bootstrap:1,source,payload:{name:launcherAsset(target,'tar.gz'),url:launcherAssetURL(version,target,'tar.gz'),bytes:bytes.length,sha256:sha256(bytes)},files};validateLauncherManifest(manifest,target,version);await writeFile(join(output,launcherAsset(target,'json')),JSON.stringify(manifest)+'\n',{flag:'wx'});return manifest;
}
