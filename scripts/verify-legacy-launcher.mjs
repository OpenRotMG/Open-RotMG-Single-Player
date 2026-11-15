import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {hashFile} from '../dist/update-format.js';
import {installArtifact,installedPaths} from './installer-install.mjs';
import {verifyLauncherUpdate} from './verify-launcher-update.mjs';
import {nativeGame} from './native-game.mjs';
// 1.0.0 is the oldest self-updating launcher; its separately installed server is what the bundled server replaces.
const original={'linux-x64':'acd7742d772e5fa2c52094eab80baaa9640c216bc92aad57bc6c4641225b2bd4','win32-x64':'a7b2a066f39a8abf45a8b913a98760162bb234fb10e357f73f0cf51177deef7e','darwin-arm64':'36ff5bccd88fbec36f180104d225ac9cd9b5a188b23605951c538464cf0a33d7'};
export async function verifyLegacyLauncher({artifact,env,out,report,check}){
 const version=JSON.parse(await readFile('package.json','utf8')).version,target=process.platform+'-'+process.arch,sha256=original[target],archive=process.env.OPENROTMG_LEGACY_ZIP;
 assert(archive,'Set OPENROTMG_LEGACY_ZIP to the published 1.0.0 ZIP for this target');assert.equal(await hashFile(archive),sha256,'Legacy ZIP differs from the published 1.0.0 release');
 const base=process.platform==='win32'?await mkdtemp(join(process.env.OPENROTMG_TEST_TMP_ROOT,'legacy-')):join(out,'legacy');await mkdir(base,{recursive:true});const old=installedPaths((await installArtifact(archive,join(base,'old'),base)).path),candidate=installedPaths((await installArtifact(artifact,join(base,'new'),base)).path),runtime=join(old.resources,'runtime');
 // An upgrade starts with old-runtime data; copying a newer database here would test an unsupported downgrade.
 execFileSync(join(runtime,process.platform==='win32'?'openrotmg.exe':'openrotmg'),['--backup-fixture',join(old.player,'state'),join(runtime,'data')],{env,timeout:30000});
 let game;const evidence={};try{await verifyLauncherUpdate({paths:old,env,out:base,report:evidence,check,verifyProgress:async url=>{if(!game){game=await nativeGame({out:base,origin:new URL(url).origin,clientURL:url,env,check,report});await game.mutate();}else await game.verify(true,url);},closeGame:()=>game.close(),installedVersion:'1.0.0',targetVersion:version,candidate});}finally{try{await game?.close();}finally{report.legacyLauncherUpdate={...evidence.launcherUpdate,publicArchiveSha256:sha256};}}
 assert.equal(report.legacyLauncherUpdate.status,'passed');check(`Actual shipped 1.0.0 upgrades to ${version}, keeps account progress and uses the bundled server`,true);
}
