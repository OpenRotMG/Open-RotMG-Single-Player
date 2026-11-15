import {cp,mkdir,readFile,writeFile,rm,chmod,lstat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {isAbsolute,join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {tree,clientFiles,sha256} from './assets.mjs';

export async function assembleRuntime(input,pins,destination){
 for(const key of ['serverSource','serverBinary','clientSource','preparedClient','serverBuildReceipt'])assert(isAbsolute(input[key]),`Absolute ${key} required`);
 for(const[path,pin]of[[input.serverSource,pins.server],[input.clientSource,pins.client]]){
  const git=(...args)=>execFileSync('git',['-C',path,...args],{encoding:'utf8'}).trim();assert.equal(git('rev-parse','HEAD'),pin.commit,'Source HEAD differs from frozen pin');assert.equal(git('status','--porcelain','--untracked-files=no'),'','Tracked source must be clean');
  assert.equal(Number(git('rev-list','--count',pin.commit)),pin.commitCount,'Source commit count differs from its full Git history');
 }
 assert.equal(input.platform,process.platform,'Build input must be native platform');assert.equal(input.arch,process.arch,'Build input must be native architecture');
 assert(!(await lstat(input.serverBinary)).isSymbolicLink(),'Binary must be regular, not symlink');assert.equal(sha256(await readFile(input.serverBinary)),input.serverBinarySha256,'Compiled binary identity mismatch');
 const receipt=JSON.parse(await readFile(input.serverBuildReceipt,'utf8'));assert.equal(receipt.head,pins.server.commit,'Build receipt source must match frozen pin');assert.equal(receipt.dirty,false,'Build receipt must be from clean committed source');assert.equal(receipt.sha256,input.serverBinarySha256,'Build receipt must identify this exact binary');
 assert.equal((await tree(input.serverSource,['data'])).sha256,pins.server.dataSha256,'Runtime data identity mismatch');
 const client=await tree(input.preparedClient,clientFiles);assert.equal(client.sha256,pins.client.preparedSha256,'Prepared client identity mismatch');
 const lock=JSON.parse(await readFile(join(input.clientSource,'ruffle/lock.json'),'utf8'));assert.equal(lock.version,pins.ruffle.version);assert.equal(lock.sourceCommit,pins.ruffle.sourceCommit);assert.equal(lock.bundleSha256,pins.ruffle.bundleSha256);assert(Object.keys(client.files).some(n=>n.endsWith('.wasm')),'Bundled Ruffle WASM required');
 await rm(destination,{recursive:true,force:true});await mkdir(join(destination,'client'),{recursive:true});await cp(join(input.serverSource,'data'),join(destination,'data'),{recursive:true});
 for(const file of clientFiles)await cp(join(input.preparedClient,file),join(destination,'client',file),{recursive:true});
 const binary=process.platform==='win32'?'openrotmg.exe':'openrotmg';await cp(input.serverBinary,join(destination,binary));await chmod(join(destination,binary),0o755);await writeFile(join(destination,'REVISION'),pins.server.commit+'\n');
 await mkdir(join(destination,'notices'),{recursive:true});await cp(join(input.serverSource,'LICENSE'),join(destination,'notices/SERVER-AGPL-3.0'));await cp(join(input.clientSource,'LICENSE'),join(destination,'notices/CLIENT-GPL-3.0'));await cp(join(input.clientSource,'ruffle/lock.json'),join(destination,'notices/ruffle-lock.json'));
 for(const name of Object.keys(client.files).filter(n=>/license|notice|copying/i.test(n)))await cp(join(input.preparedClient,name),join(destination,'notices',name.replaceAll('/','-')));
 for(const file of ['NOTICES.md','LICENSE'])await cp(file,join(destination,'notices',file));
 await writeFile(join(destination,'notices/source-pins.json'),JSON.stringify(pins,null,2)+'\n');
 const packaged=await tree(destination,['data','client','notices',binary,'REVISION']);
 await writeFile(join(destination,'build-identity.json'),JSON.stringify({pins,platform:process.platform,arch:process.arch,binarySha256:input.serverBinarySha256,buildReceiptSha256:sha256(await readFile(input.serverBuildReceipt)),assetsSha256:packaged.sha256},null,2));
}

assert(process.env.OPENROTMG_BUILD_INPUTS&&isAbsolute(process.env.OPENROTMG_BUILD_INPUTS),'Set OPENROTMG_BUILD_INPUTS to an absolute build-input JSON (see docs/development.md)');
await assembleRuntime(JSON.parse(await readFile(process.env.OPENROTMG_BUILD_INPUTS,'utf8')),JSON.parse(await readFile('source-pins.json','utf8')),resolve('runtime'));
await cp('.qa/renderer/renderer.js','dist/renderer.js');for(const file of ['index.html','style.css','game.html','game.css','game-report.js'])await cp(`src/${file}`,`dist/${file}`);
await cp('src/assets','dist/assets',{recursive:true});
console.log(`Bundled pinned server and client for ${process.platform}/${process.arch}`);
