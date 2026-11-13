import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {installArtifact,installedPaths} from './installer-install.mjs';
import {verifyLauncherUpdate} from './verify-launcher-update.mjs';
import {nativeGame} from './native-game.mjs';
const require=createRequire(import.meta.url),{createLauncherPolicy}=require('../dist/update-policy.js'),{downloadPayload}=require('../dist/update-network.js');
// Immutable public ZIP digests keep this regression on the shipped updater, not a rebuilt approximation.
const original={'linux-x64':[175629711,'20eb5aedc40b5ad647f3821c096f032dab1c314e2902504ebef62b0ee35acf51'],'win32-x64':[208909365,'7e7bdaf3c621f9c186c8b1a36ba9b852073116cba6fa3e704e631115a42b7edf'],'darwin-arm64':[170149666,'48d1c6c64e16bb367df3d4f55547fa81f629729970a9dfd7f2161424fa263b29']};
export async function verifyLegacyLauncher({artifact,env,out,report,check}){
 const version=JSON.parse(await readFile('package.json','utf8')).version,target=process.platform+'-'+process.arch,[bytes,sha256]=original[target],archive=join(out,'public-0.1.4.zip'),policy=createLauncherPolicy('',version);await downloadPayload({payload:{url:`https://github.com/OpenRotMG/Open-RotMG-Single-Player/releases/download/v0.1.4/openrotmg-singleplayer-0.1.4-${target}.zip`,bytes,sha256}},archive,policy,new AbortController().signal);
 const base=process.platform==='win32'?await mkdtemp(join(process.env.OPENROTMG_TEST_TMP_ROOT,'legacy-')):join(out,'legacy');await mkdir(base,{recursive:true});const old=installedPaths((await installArtifact(archive,join(base,'old'),base)).path),candidate=installedPaths((await installArtifact(artifact,join(base,'new'),base)).path),runtime=join(old.resources,'runtime');
 // An upgrade starts with old-runtime data; copying a newer database here would test an unsupported downgrade.
 execFileSync(join(runtime,process.platform==='win32'?'openrotmg.exe':'openrotmg'),['--backup-fixture',join(old.player,'state'),join(runtime,'data')],{env,timeout:30000});
 let game;const evidence={};try{await verifyLauncherUpdate({paths:old,env,out:base,report:evidence,check,verifyProgress:async url=>{if(!game){game=await nativeGame({out:base,origin:new URL(url).origin,clientURL:url,env,check,report,normalCache:true});await game.mutate();}else await game.verify(true,url);},closeGame:()=>game.close(),installedVersion:'0.1.4',targetVersion:version,candidate});}finally{try{await game?.close();}finally{report.legacyLauncherUpdate={...evidence.launcherUpdate,publicArchiveSha256:sha256,publicArchiveBytes:bytes};}}
 assert.equal(report.legacyLauncherUpdate.status,'passed');check(`Actual shipped 0.1.4 upgrades to ${version} with legacy profile migration, identical account progress and cold reopen`,true);
}
