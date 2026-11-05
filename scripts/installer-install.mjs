import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,cp,readdir,lstat,chmod,rm,rename} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';

export function installedPaths(root,version,platform=process.platform){
 const app=platform==='darwin'?join(root,'Open RotMG Single Player.app'):platform==='win32'?join(root,`app-${version}`):root;
 return {app,resources:join(app,platform==='darwin'?'Contents/Resources':'resources'),executable:join(app,platform==='darwin'?'Contents/MacOS/openrotmg-single-player':platform==='win32'?'openrotmg-single-player.exe':'openrotmg-single-player')};
}
export async function writableOwnedInstallation(root){
 if(process.platform==='win32')return;
 async function visit(path){const info=await lstat(path);if(info.isSymbolicLink())return;await chmod(path,info.mode|0o200);if(info.isDirectory())for(const name of await readdir(path))await visit(join(path,name));}
 await visit(root);
}
export async function installArtifact(artifact,root,out,reinstall=false){
 const inside=relative(out,root);assert(inside&&!inside.startsWith('..')&&!isAbsolute(inside),'Installation must stay in this run-owned directory');
 if(process.platform==='win32'){
  assert(artifact.endsWith('.msi'));assert.equal(process.env.GITHUB_ACTIONS,'true','MSI install is restricted to an owned hosted Windows VM');
  execFileSync('msiexec.exe',[reinstall?'/fa':'/i',artifact,'/qn','/norestart','MSIINSTALLPERUSER=1',`APPLICATIONROOTDIRECTORY=${root}`, '/L*v',join(out,reinstall?'reinstall.log':'install.log')],{timeout:300000});
 }else if(process.platform==='darwin'){
  assert(artifact.endsWith('.dmg'));const mount=join(out,'mounted image');await mkdir(mount,{recursive:true});
  execFileSync('hdiutil',['attach',artifact,'-readonly','-nobrowse','-mountpoint',mount],{timeout:60000});
  try{if(reinstall)await rm(root,{recursive:true});await mkdir(root,{recursive:true});await cp(join(mount,'Open RotMG Single Player.app'),join(root,'Open RotMG Single Player.app'),{recursive:true,verbatimSymlinks:true});}
  finally{execFileSync('hdiutil',['detach',mount],{timeout:60000});}
 }else{
  assert.equal(process.platform,'linux');assert(artifact.endsWith('.zip'));
  const extracted=join(out,reinstall?'reinstalled archive':'extracted archive');await mkdir(extracted);
  execFileSync('unzip',['-q',artifact,'-d',extracted],{timeout:120000});
  const directory='Open RotMG Single Player-linux-x64';assert.deepEqual(await readdir(extracted),[directory],'Expected exact Forge Linux package root');
  if(reinstall)await rm(root,{recursive:true});await rename(join(extracted,directory),root);
 }
 return {kind:process.platform==='win32'?'native per-user MSI install/repair':process.platform==='darwin'?'read-only DMG mount and application copy':'Forge ZIP extraction',path:root,reinstall};
}
