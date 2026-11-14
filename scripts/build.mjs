import {cp,mkdir,mkdtemp,readFile,writeFile,rm,rename,stat} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {assembleRuntime} from './runtime-payload.mjs';
import {boundedFile,exact,hashFile,integer,targetName,verifyManifest,verifyRuntime,saveCompatibility,launcherVersion,versionAtLeast} from '../dist/update-format.js';
import {extractRuntime} from '../dist/update-archive.js';
import {MANIFEST_PUBLIC_KEY} from '../dist/update-policy.js';

assert(process.env.OPENROTMG_BUILD_INPUTS&&isAbsolute(process.env.OPENROTMG_BUILD_INPUTS),'Set OPENROTMG_BUILD_INPUTS to an absolute explicit build-input JSON (see README)');
const input=JSON.parse(await readFile(process.env.OPENROTMG_BUILD_INPUTS,'utf8'));
let baseline;
if(input.runtimeRelease!==undefined){
 exact(input.runtimeRelease,'manifest,signature,archive','promoted release build inputs');
 const release=input.runtimeRelease;for(const key of ['manifest','signature','archive'])assert(isAbsolute(release[key]),`Absolute promoted ${key} required`);
 const manifest=await boundedFile(release.manifest,64*1024),signature=await boundedFile(release.signature,64),launcher=JSON.parse(await readFile('package.json','utf8')).version;
 const value=verifyManifest(manifest,signature,MANIFEST_PUBLIC_KEY,undefined,undefined,targetName(),launcher,'https://github.com');
 assert.equal((await stat(release.archive)).size,value.payload.bytes,'Promoted archive byte length mismatch');
 assert.equal(await hashFile(release.archive),value.payload.sha256,'Promoted archive digest differs; no recompilation/recompression substitution is allowed');
 await mkdir('.qa',{recursive:true});const stage=await mkdtemp(resolve('.qa/release-baseline-'));
 try{
  await extractRuntime(release.archive,join(stage,'runtime'),targetName(),value.payload.expandedBytes);await verifyRuntime(join(stage,'runtime'),targetName(),value);
  await rm('runtime',{recursive:true,force:true});await rename(join(stage,'runtime'),resolve('runtime'));
 }finally{await rm(stage,{recursive:true});}
 baseline={format:1,mode:'release',identitySha256:value.payload.identitySha256,startupBackup:1,clientNamespace:1,manifest:manifest.toString('base64'),signature:signature.toString('base64')};
}else{
 const pins=JSON.parse(await readFile('source-pins.json','utf8')),capabilities=JSON.parse(await readFile('runtime-capabilities.json','utf8'));
 exact(capabilities,'format,server,minLauncher,clientNamespace,save'+(Object.hasOwn(capabilities,'desktopMetadata')?',desktopMetadata':'')+(Object.hasOwn(capabilities,'accountManagement')?',accountManagement':''),'explicit source runtime capabilities');
 launcherVersion(capabilities.minLauncher);assert(versionAtLeast(JSON.parse(await readFile('package.json')).version,capabilities.minLauncher),'Source runtime requires a newer launcher');
 if(Object.hasOwn(capabilities,'accountManagement'))assert([1,2].includes(capabilities.accountManagement),'Invalid local account management declaration');
 if(Object.hasOwn(capabilities,'desktopMetadata'))assert([0,1].includes(capabilities.desktopMetadata),'Invalid bundled metadata declaration');exact(capabilities.save,'cli,read,write,startupBackup','source save capabilities');
 assert(capabilities.format===1&&capabilities.server===pins.server.commit&&capabilities.save.cli===1&&saveCompatibility(capabilities.save)&&integer(capabilities.save.startupBackup,0,1)&&integer(capabilities.clientNamespace,0,1),'Unsupported explicit source capabilities');
 const prepared=await assembleRuntime(input,pins,resolve('runtime'),{startupBackup:capabilities.save.startupBackup,clientNamespace:capabilities.clientNamespace,desktopMetadata:capabilities.desktopMetadata,accountManagement:capabilities.accountManagement,save:capabilities.save});
 baseline={format:1,mode:'source',identitySha256:prepared.identitySha256,startupBackup:prepared.startupBackup,clientNamespace:prepared.clientNamespace};
}
await writeFile('dist/runtime-baseline.json',JSON.stringify(baseline,null,2)+'\n');
await cp('.qa/renderer/renderer.js','dist/renderer.js');for(const file of ['index.html','style.css','game.html','game.css'])await cp(`src/${file}`,`dist/${file}`);
await cp('src/assets','dist/assets',{recursive:true});
console.log(`Prepared explicit ${baseline.mode} baseline ${process.platform}/${process.arch}; identity ${baseline.identitySha256}`);
