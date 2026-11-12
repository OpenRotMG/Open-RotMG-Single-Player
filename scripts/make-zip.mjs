import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,cp,copyFile,readdir,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {launcherBundle} from './launcher-bundle.mjs';
const {launcherInventory}=createRequire(import.meta.url)('../dist/launcher-package.js');

export const portableFolder='OpenRotMG Singleplayer';
export const launcherName=(platform=process.platform)=>platform==='win32'?'OpenRotMG Singleplayer.exe':'OpenRotMG Singleplayer';
export const portableEntries=(platform=process.platform)=>[launcherName(platform),'README.txt','player data','server data'].sort();
// PATH on hosted Windows can resolve Git's GNU tar, which cannot read or write ZIP.
export const windowsTar=()=>{assert(process.env.SystemRoot,'SystemRoot is required to locate the Windows tar.exe');return join(process.env.SystemRoot,'System32','tar.exe');};
export async function portableZip({packageDir,launcher,readme,stage,zip,platform=process.platform}){
 const root=join(stage,portableFolder);
 await mkdir(join(root,'player data'),{recursive:true});
 await cp(packageDir,join(root,'server data/baseline'),{recursive:true,verbatimSymlinks:true});
 await (await import('node:fs/promises')).writeFile(join(root,'server data/launcher-selection.json'),JSON.stringify({format:1,generation:'baseline'})+'\n');
 await (await import('node:fs/promises')).writeFile(join(root,'server data/launcher-baseline.json'),JSON.stringify({format:1,version:JSON.parse(await readFile('package.json','utf8')).version,files:await launcherInventory(join(root,'server data/baseline'))})+'\n');
 await copyFile(launcher,join(root,launcherName(platform)));await copyFile(readme,join(root,'README.txt'));
 assert.deepEqual((await readdir(root)).sort(),portableEntries(platform));
 if(platform==='darwin')execFileSync('ditto',['-c','-k','--norsrc','--keepParent',root,zip]);
 else if(platform==='win32')execFileSync(windowsTar(),['-a','-c','-f',zip,portableFolder],{cwd:stage});
 else execFileSync('zip',['-q','-r','-y','-X',zip,portableFolder],{cwd:stage});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const version=JSON.parse(await readFile('package.json','utf8')).version,platform=process.platform,arch=process.arch;
 execFileSync('cargo',['build','--release','--locked','--manifest-path','launcher/Cargo.toml'],{stdio:'inherit'});
 for(const path of ['out/make','out/portable-stage','out/launcher-payload'])await rm(path,{recursive:true,force:true});await mkdir('out/make',{recursive:true});
 const packageDir=resolve(`out/Open RotMG Single Player-${platform}-${arch}`),launcher=resolve('launcher/target/release/openrotmg-singleplayer'+(platform==='win32'?'.exe':''));
 await portableZip({packageDir,launcher,readme:resolve('launcher/README.txt'),stage:resolve('out/portable-stage'),zip:resolve(`out/make/openrotmg-singleplayer-${version}-${platform}-${arch}.zip`)});
 await launcherBundle({packageDir,launcher,stage:resolve('out/launcher-payload'),output:resolve('out/make'),version,target:`${platform}-${arch}`,source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()});
}
