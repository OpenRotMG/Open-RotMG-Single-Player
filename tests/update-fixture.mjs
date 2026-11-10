import {mkdir,mkdtemp,writeFile,readFile,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {generateKeyPairSync,sign} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {Header,create} from 'tar';
import {tree,clientFiles} from '../scripts/assets.mjs';
import {digest,runtimeFiles} from '../dist/update-format.js';

export async function directory(name){await mkdir('.qa/unit',{recursive:true});return mkdtemp(resolve('.qa/unit',name+'-'));}
export const keyPair=()=>generateKeyPairSync('ed25519');
export const publicPEM=keys=>keys.publicKey.export({type:'spki',format:'pem'}).toString();
export const signed=(manifest,keys)=>{const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');return{bytes,signature:sign(null,bytes,keys.privateKey)};};
export async function unitRuntime(root,{serverCommit='1'.repeat(40),clientCommit='2'.repeat(40),legacy=false,desktopMetadata,schema=22,data='unit test content, not a runnable server'}={}){
 for(const dir of ['data','client/vendor','notices'])await mkdir(join(root,dir),{recursive:true});
 const write=(path,value)=>writeFile(join(root,path),value);
 await write('data/content.xml',data);
 for(const file of clientFiles.filter(n=>n!=='vendor'))await write('client/'+file,'unit '+file);
 await write('client/vendor/unit.wasm',Buffer.from([0,97,115,109]));
 const header=Buffer.alloc(64);header.set([127,69,76,70,2,1]);header.writeUInt16LE(62,18);await write('openrotmg',header);
 const pins={server:{repository:'https://github.com/dginovker/Open-RotMG-Server',upstream:'https://github.com/OpenRotMG/Open-RotMG-Server',commit:serverCommit,dataSha256:(await tree(root,['data'])).sha256},client:{repository:'https://github.com/OpenRotMG/Open-RotMG-Client',upstream:'https://github.com/OpenRotMG/Open-RotMG-Client',commit:clientCommit,preparedSha256:(await tree(join(root,'client'),clientFiles)).sha256},ruffle:{version:'unit.1',sourceCommit:'3'.repeat(40),bundleSha256:'4'.repeat(64)}};
 await write('REVISION',pins.server.commit+'\n');await write('notices/ruffle-lock.json',JSON.stringify(pins.ruffle));
 await write('notices/runtime-capabilities.json',JSON.stringify({format:1,server:pins.server.commit,clientNamespace:legacy?0:1,...(desktopMetadata===undefined?{}:{desktopMetadata}),save:{cli:1,read:schema===23?[21,22,23]:[21,22],write:schema,startupBackup:legacy?0:1}}));
 const inventory=await tree(root,['data','client','notices','openrotmg','REVISION']);
 await write('inventory.json',JSON.stringify({files:Object.keys(inventory.files),sha256:inventory.files},null,2));
 const identity={pins,platform:'linux',arch:'x64',binarySha256:inventory.files.openrotmg,buildReceiptSha256:'5'.repeat(64),assetsSha256:inventory.sha256};
 await write('build-identity.json',JSON.stringify(identity,null,2));return identity;
}
export async function payload(root,archive){
 const files=await runtimeFiles(root,'linux-x64');
 await create({file:archive,cwd:root,gzip:true,portable:true,noPax:true,mtime:new Date(0)},files);
 return{bytes:(await stat(archive)).size,sha256:digest(await readFile(archive)),expandedBytes:(await Promise.all(files.map(f=>stat(join(root,f))))).reduce((n,s)=>n+s.size,0)};
}
export async function manifestFor(root,archive,origin='https://github.com',sequence=1){
 const identity=JSON.parse(await readFile(join(root,'build-identity.json'),'utf8'));
 return{format:1,releaseId:100+sequence,tag:`fixture-${sequence}`,version:`unit-runtime-${sequence}`,sequence,target:'linux-x64',minLauncher:'0.1.0',clientNamespace:1,save:{cli:1,read:[21,22],write:22,startupBackup:1},pins:identity.pins,payload:{id:200+sequence,name:'runtime-linux-x64.tar.gz',url:`${origin}/OpenRotMG/Open-RotMG-Single-Player/releases/download/fixture-${sequence}/runtime-linux-x64.tar.gz`,...await payload(root,archive),assetsSha256:identity.assetsSha256,identitySha256:digest(await readFile(join(root,'build-identity.json'))),binarySha256:identity.binarySha256}};
}
export function rawArchive(entries){
 const blocks=[];
 for(const e of entries){
  const body=Buffer.from(e.body??'x'),header=Buffer.alloc(512);
  new Header({path:e.path,type:e.type??'File',size:body.length,mode:e.mode??0o600,mtime:new Date(0),linkpath:e.linkpath}).encode(header);
  // Retain deliberately malformed raw path bytes even on Windows, where producer APIs normalize backslashes.
  if(e.rawPath!==undefined){header.fill(0,0,100);header.write(e.rawPath,0,100);header.fill(32,148,156);let sum=0;for(const byte of header)sum+=byte;header.write(sum.toString(8).padStart(6,'0')+'\0 ',148,8);}
  blocks.push(header,body,Buffer.alloc((512-body.length%512)%512));
 }
 return gzipSync(Buffer.concat([...blocks,Buffer.alloc(1024)]));
}
