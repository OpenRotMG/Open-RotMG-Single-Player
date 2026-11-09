import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,cp,copyFile,readdir,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export const launcherName=(platform=process.platform)=>platform==='win32'?'OpenRotMG Singleplayer.exe':'OpenRotMG Singleplayer';
export const portableEntries=(platform=process.platform)=>[launcherName(platform),'README.txt','player data','server data'].sort();
// PATH on hosted Windows can resolve Git's GNU tar, which cannot read or write ZIP.
export const windowsTar=()=>{assert(process.env.SystemRoot,'SystemRoot is required to locate the Windows tar.exe');return join(process.env.SystemRoot,'System32','tar.exe');};
export async function portableZip({packageDir,launcher,readme,stage,zip,platform=process.platform}){
 await mkdir(join(stage,'player data'),{recursive:true});
 await cp(packageDir,join(stage,'server data'),{recursive:true,verbatimSymlinks:true});
 await copyFile(launcher,join(stage,launcherName(platform)));await copyFile(readme,join(stage,'README.txt'));
 const entries=portableEntries(platform);assert.deepEqual((await readdir(stage)).sort(),entries);
 if(platform==='darwin')execFileSync('ditto',['-c','-k','--norsrc',stage,zip]);
 else if(platform==='win32')execFileSync(windowsTar(),['-a','-c','-f',zip,'-C',stage,...entries]);
 else execFileSync('zip',['-q','-r','-y','-X',zip,...entries],{cwd:stage});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const version=JSON.parse(await readFile('package.json','utf8')).version,platform=process.platform,arch=process.arch;
 execFileSync('cargo',['build','--release','--locked','--manifest-path','launcher/Cargo.toml'],{stdio:'inherit'});
 for(const path of ['out/make','out/portable-stage'])await rm(path,{recursive:true,force:true});await mkdir('out/make',{recursive:true});
 await portableZip({packageDir:resolve(`out/Open RotMG Single Player-${platform}-${arch}`),launcher:resolve('launcher/target/release/openrotmg-singleplayer'+(platform==='win32'?'.exe':'')),readme:resolve('launcher/README.txt'),stage:resolve('out/portable-stage'),zip:resolve(`out/make/openrotmg-singleplayer-${version}-${platform}-${arch}.zip`)});
}
