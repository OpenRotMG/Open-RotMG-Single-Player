import assert from 'node:assert/strict';
import {mkdir,lstat,readdir,link,symlink,readlink,readFile,writeFile,copyFile,realpath,rename} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{launcherInventory}=require('../dist/launcher-package.js');let built=false;
export const runtimeTestStorage=profile=>join(basename(profile)==='player data'?dirname(profile):resolve(profile)+'-portable','server data/profile');
export async function runtimeTestPortable(executable,profile){
 if(!built){execFileSync('cargo',['build','--release','--locked','--manifest-path','launcher/Cargo.toml'],{stdio:'inherit'});built=true;}
 await mkdir(profile,{recursive:true});profile=resolve(profile);const root=dirname(runtimeTestStorage(profile)).replace(/[\\/]server data$/,''),packageDir=process.platform==='darwin'?resolve(dirname(executable),'../../..'):dirname(executable),native=process.platform==='win32'?'OpenRotMG Singleplayer.exe':'OpenRotMG Singleplayer',marker=join(root,'qualification-root.json');let exists=true;try{await lstat(root);}catch(error){if(error.code!=='ENOENT')throw error;exists=false;}
 if(!exists){await mkdir(root);const server=join(root,'server data'),baseline=join(server,'baseline');await mkdir(server);await mkdir(baseline);
  // Repeated runtime profiles share immutable package bytes, but never code-directory aliases or save ownership.
  async function populate(source,destination){for(const entry of await readdir(source,{withFileTypes:true})){const from=join(source,entry.name),to=join(destination,entry.name);if(entry.isDirectory()){await mkdir(to);await populate(from,to);}else if(entry.isSymbolicLink())await symlink(await readlink(from),to);else{assert(entry.isFile());await link(from,to);}}}await populate(packageDir,baseline);
  await copyFile(resolve('launcher/target/release/openrotmg-singleplayer'+(process.platform==='win32'?'.exe':'')),join(root,native));await rename(profile,join(root,'player data'));await symlink(join(root,'player data'),profile,process.platform==='win32'?'junction':'dir');await writeFile(join(server,'launcher-selection.json'),JSON.stringify({format:1,generation:'baseline'}));const version=JSON.parse(await readFile('package.json','utf8')).version;await writeFile(join(server,'launcher-baseline.json'),JSON.stringify({format:1,version,files:await launcherInventory(baseline)}));await writeFile(marker,JSON.stringify({packageDir:await realpath(packageDir),profile}));
 }
 const binding=JSON.parse(await readFile(marker,'utf8'));assert.equal(binding.packageDir,await realpath(packageDir));assert.equal(await realpath(binding.profile),await realpath(profile));const electron=process.platform==='darwin'?join(root,'server data/baseline/Open RotMG Single Player.app/Contents/MacOS/openrotmg-single-player'):join(root,'server data/baseline',process.platform==='win32'?'openrotmg-single-player.exe':'openrotmg-single-player');return{executablePath:join(root,native),electronPath:electron,profile:await realpath(join(root,'player data'))};
}
