import {cp,mkdir,readFile,writeFile,rm,chmod,lstat,stat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {isAbsolute,join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {create} from 'tar';
import {tree,clientFiles,sha256} from './assets.mjs';
import {hashFile,MAX_EXPANDED,MAX_PAYLOAD,runtimeFiles,targetName,verifyCapabilities,verifyRuntime,saveCompatibility} from '../dist/update-format.js';

export async function assembleRuntime(input,pins,destination,{startupBackup,clientNamespace,desktopMetadata,accountManagement,save,noticesRoot=resolve('.')}={}){
 assert([0,1].includes(startupBackup)&&[0,1].includes(clientNamespace),'Explicit tested startup-backup/client-namespace capabilities required');
 assert(desktopMetadata===undefined||[0,1].includes(desktopMetadata),'Invalid explicit bundled metadata capability');
 assert(save&&save.cli===1&&saveCompatibility(save)&&save.startupBackup===startupBackup,'Explicit compatible save protocol/schema required');
 for(const key of ['serverSource','serverBinary','clientSource','preparedClient','serverBuildReceipt'])assert(isAbsolute(input[key]),`Absolute ${key} required`);
 assert(isAbsolute(destination)&&isAbsolute(noticesRoot),'Absolute producer output/notices roots required');
 for(const[path,pin]of[[input.serverSource,pins.server],[input.clientSource,pins.client]]){
  const git=(...args)=>execFileSync('git',['-C',path,...args],{encoding:'utf8'}).trim();assert.equal(git('rev-parse','HEAD'),pin.commit,'Source HEAD differs from frozen pin');assert.equal(git('status','--porcelain','--untracked-files=no'),'','Tracked source must be clean');
  if(save.write===23||pin.commitCount!==undefined)assert.equal(Number(git('rev-list','--count',pin.commit)),pin.commitCount,'Source commit count differs from its full Git history');
 }
 assert.equal(input.platform,process.platform,'Build input must be native platform');assert.equal(input.arch,process.arch,'Build input must be native architecture');
 assert(/^[0-9a-f]{64}$/.test(input.serverBinarySha256),'Explicit binary SHA256 required');assert(!(await lstat(input.serverBinary)).isSymbolicLink(),'Binary must be regular, not symlink');assert.equal(sha256(await readFile(input.serverBinary)),input.serverBinarySha256,'Compiled binary identity mismatch');
 const receipt=JSON.parse(await readFile(input.serverBuildReceipt,'utf8'));assert.equal(receipt.head,pins.server.commit,'Build receipt source must match frozen pin');assert.equal(receipt.dirty,false,'Build receipt must be from clean committed source');assert.equal(receipt.sha256,input.serverBinarySha256,'Build receipt must identify this exact binary');
 assert.equal((await tree(input.serverSource,['data'])).sha256,pins.server.dataSha256,'Runtime data identity mismatch');
 const client=await tree(input.preparedClient,clientFiles);assert.equal(client.sha256,pins.client.preparedSha256,'Prepared client identity mismatch');
 for(const name of clientFiles.filter(n=>n!=='vendor'&&n!=='native-texture-editor.swf'))assert.equal(sha256(await readFile(join(input.clientSource,name))),client.files[name],`Prepared client source differs: ${name}`);
 const lock=JSON.parse(await readFile(join(input.clientSource,'ruffle/lock.json'),'utf8'));assert.equal(lock.version,pins.ruffle.version);assert.equal(lock.sourceCommit,pins.ruffle.sourceCommit);assert.equal(lock.bundleSha256,pins.ruffle.bundleSha256);assert(Object.keys(client.files).some(n=>n.endsWith('.wasm')),'Bundled Ruffle WASM required');
 await rm(destination,{recursive:true,force:true});await mkdir(join(destination,'client'),{recursive:true});await cp(join(input.serverSource,'data'),join(destination,'data'),{recursive:true});
 for(const file of clientFiles)await cp(join(input.preparedClient,file),join(destination,'client',file),{recursive:true});
 const binary=process.platform==='win32'?'openrotmg.exe':'openrotmg';await cp(input.serverBinary,join(destination,binary));await chmod(join(destination,binary),0o755);await writeFile(join(destination,'REVISION'),pins.server.commit+'\n');
 await mkdir(join(destination,'notices'),{recursive:true});await cp(join(input.serverSource,'LICENSE'),join(destination,'notices/SERVER-AGPL-3.0'));await cp(join(input.clientSource,'LICENSE'),join(destination,'notices/CLIENT-GPL-3.0'));await cp(join(input.clientSource,'ruffle/lock.json'),join(destination,'notices/ruffle-lock.json'));
 for(const name of Object.keys(client.files).filter(n=>/license|notice|copying/i.test(n)))await cp(join(input.preparedClient,name),join(destination,'notices',name.replaceAll('/','-')));
 for(const file of ['NOTICES.md','LICENSE'])await cp(join(noticesRoot,file),join(destination,'notices',file));
 await writeFile(join(destination,'notices/source-pins.json'),JSON.stringify(pins,null,2)+'\n');
 if(accountManagement!==undefined){assert([1,2].includes(accountManagement));await writeFile(join(destination,'notices/account-management.json'),JSON.stringify({format:1,server:pins.server.commit,cli:accountManagement,storage:1})+'\n');}
 await writeFile(join(destination,'notices/runtime-capabilities.json'),JSON.stringify({format:1,server:pins.server.commit,clientNamespace,...(desktopMetadata===undefined?{}:{desktopMetadata}),save},null,2)+'\n');
 const packaged=await tree(destination,['data','client','notices',binary,'REVISION']);await writeFile(join(destination,'inventory.json'),JSON.stringify({files:Object.keys(packaged.files),sha256:packaged.files},null,2));
 await writeFile(join(destination,'build-identity.json'),JSON.stringify({pins,platform:process.platform,arch:process.arch,binarySha256:input.serverBinarySha256,buildReceiptSha256:sha256(await readFile(input.serverBuildReceipt)),assetsSha256:packaged.sha256},null,2));
 const identity=await verifyRuntime(destination,targetName());await verifyCapabilities(destination,identity.pins,startupBackup,clientNamespace,desktopMetadata);return{identity,identitySha256:sha256(await readFile(join(destination,'build-identity.json'))),startupBackup,clientNamespace};
}
export async function archiveRuntime(root,output,{startupBackup,clientNamespace}){
 assert([0,1].includes(startupBackup)&&[0,1].includes(clientNamespace),'Explicit actual runtime capabilities required');
 assert(isAbsolute(root)&&isAbsolute(output),'Absolute runtime/archive paths required');const target=targetName(),identity=await verifyRuntime(root,target),files=await runtimeFiles(root,target);await verifyCapabilities(root,identity.pins,startupBackup,clientNamespace);
 await create({file:output,cwd:root,gzip:true,portable:true,noPax:true,mtime:new Date(0)},files);
 const bytes=(await stat(output)).size,expandedBytes=(await Promise.all(files.map(path=>stat(join(root,path))))).reduce((n,s)=>n+s.size,0);assert(bytes>0&&bytes<=MAX_PAYLOAD&&expandedBytes>0&&expandedBytes<=MAX_EXPANDED,'Produced runtime exceeds consumer archive bounds');
 return{target,pins:identity.pins,startupBackup,clientNamespace,payload:{name:`runtime-${target}.tar.gz`,bytes,sha256:await hashFile(output),expandedBytes,assetsSha256:identity.assetsSha256,identitySha256:sha256(await readFile(join(root,'build-identity.json'))),binarySha256:identity.binarySha256}};
}
