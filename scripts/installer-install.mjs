import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,readdir} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {launcherName,portableEntries,portableFolder,windowsTar} from './make-zip.mjs';

export function installedPaths(root,platform=process.platform){
 const server=join(root,'server data'),app=platform==='darwin'?join(server,'Open RotMG Single Player.app'):server;
 return {launcher:join(root,launcherName(platform)),player:join(root,'player data'),server,resources:join(app,platform==='darwin'?'Contents/Resources':'resources'),executable:join(app,platform==='darwin'?'Contents/MacOS/openrotmg-single-player':platform==='win32'?'openrotmg-single-player.exe':'openrotmg-single-player')};
}
export async function installArtifact(artifact,root,out){
 const inside=relative(out,root);assert(inside&&!inside.startsWith('..')&&!isAbsolute(inside),'Extraction must stay in this run-owned directory');
 assert(artifact.endsWith('.zip'));await mkdir(root);
 if(process.platform==='darwin')execFileSync('ditto',['-x','-k',artifact,root],{timeout:120000});
 // Windows tar.exe takes ANSI arguments, so a non-ASCII -C directory is unreachable; Node sets a Unicode cwd.
 else if(process.platform==='win32')execFileSync(windowsTar(),['-x','-f',artifact],{cwd:root,timeout:120000});
 else execFileSync('unzip',['-q',artifact,'-d',root],{timeout:120000});
 assert.deepEqual(await readdir(root),[portableFolder],'ZIP must extract into one OpenRotMG Singleplayer folder');
 const path=join(root,portableFolder);
 assert.deepEqual((await readdir(path)).sort(),portableEntries(),'Game folder must contain exactly the launcher, README.txt, player data and server data');
 assert.deepEqual(await readdir(join(path,'player data')),[],'A fresh ZIP ships an empty player data folder');
 return {kind:'portable ZIP extraction',path};
}
