import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {installerBindings,validateInstallerPromotion} from '../scripts/installer-inputs.mjs';
import {installedPaths} from '../scripts/installer-install.mjs';
import {REPOSITORY} from '../dist/update-format.js';

const sha='a'.repeat(40),runtime='b'.repeat(40);
const env={INSTALLER_SHA:sha,RUNTIME_HEAD:runtime,RUNTIME_NATIVE_RUN:'123',RUNTIME_PROMOTION_RUN:'456',RELEASE_TAG:'v0.1.0'};
const binding=()=>installerBindings(env,sha);
function metadata(){
 const run=(id,path)=>({id,head_sha:runtime,head_branch:'main',event:'workflow_dispatch',path,conclusion:'success',head_repository:{full_name:REPOSITORY}});
 return {promotion:run(456,'.github/workflows/promote-runtime.yml'),native:run(123,'.github/workflows/runtime-updates-test.yml'),validated:{head:runtime,runId:123,tag:'v0.1.0',sequence:1,targets:[{target:'linux-x64'}]},release:{id:100,tag_name:'v0.1.0',target_commitish:runtime,assets:['.json','.json.sig','.tar.gz'].map((suffix,index)=>({id:101+index,size:index+1,name:'runtime-linux-x64'+suffix,browser_download_url:`https://github.com/${REPOSITORY}/releases/download/v0.1.0/runtime-linux-x64${suffix}`}))}};
}
test('installer-inputs requires exact installer/ref, runtime SHA, run IDs and release tag without defaults',()=>{
 assert.equal(binding().installerSourceHead,sha);assert.equal(binding().runtimeHead,runtime);
 for(const key of Object.keys(env))assert.throws(()=>installerBindings({...env,[key]:''},sha));
 for(const value of ['main','latest','v0.1.0','a'.repeat(39)])assert.throws(()=>installerBindings({...env,INSTALLER_SHA:value},sha));
 assert.throws(()=>installerBindings(env,runtime));
 assert.throws(()=>installerBindings({...env,RELEASE_TAG:'v0.1.0/../../main'},sha));
});
test('installer-inputs binds both trusted-main runs and the exact promoted target/assets without treating installer HEAD as runtime HEAD',()=>{
 const value=validateInstallerPromotion(binding(),metadata(),'linux-x64');assert.equal(value.assets[2].id,103);
 const mutate=[m=>m.promotion.head_sha=sha,m=>m.native.head_sha=sha,m=>m.native.conclusion='failure',m=>m.promotion.event='pull_request',m=>m.promotion.head_branch='candidate',m=>m.promotion.path='.github/workflows/offline-installers.yml',m=>m.promotion.head_repository.full_name='other/repo',m=>m.native.id=999,m=>m.validated.runId=999,m=>m.validated.head=sha,m=>m.validated.tag='v9.9.9',m=>m.validated.sequence=0,m=>m.validated.targets.push({target:'linux-x64'}),m=>m.release.target_commitish='main',m=>m.release.tag_name='latest',m=>m.release.assets.pop(),m=>m.release.assets.push(m.release.assets[0]),m=>m.release.assets[0].browser_download_url='https://example.org/runtime.json',m=>m.release.assets[2].id=0];
 for(const change of mutate){const m=metadata();change(m);assert.throws(()=>validateInstallerPromotion(binding(),m,'linux-x64'));}
 assert.throws(()=>validateInstallerPromotion(binding(),metadata(),'win32-x64'));
});
test('Forge makers produce real MSI, DMG and Linux-only ZIP without updater/installer event runtime changes',()=>{
 const require=createRequire(import.meta.url),forge=require('../forge.config.js');
 assert.deepEqual(forge.makers.map(m=>m.name),['@electron-forge/maker-wix','@electron-forge/maker-dmg','@electron-forge/maker-zip']);
 const msi=forge.makers[0].config;assert.equal(msi.exe,'openrotmg-single-player');assert.equal(msi.upgradeCode,'7522D023-3273-4AE6-B640-96B70E283FA8');assert.equal(msi.defaultInstallMode,'perUser');assert.deepEqual(msi.features,{autoUpdate:false,autoLaunch:false});assert.equal(msi.autoRun,false);assert.deepEqual(forge.makers[2].platforms,['linux']);assert.deepEqual(forge.packagerConfig.extraResource,['runtime']);
 for(const m of forge.makers){assert(!m.config.windowsSign);assert(!m.config.osxSign);assert(!m.config.osxNotarize);}
});
test('installedPaths points at actual MSI version payload and copied DMG application, not preinstall out tree',()=>{
 assert.equal(installedPaths('/owned é','0.1.0','win32').executable,join('/owned é','app-0.1.0/openrotmg-single-player.exe'));
 assert.equal(installedPaths('/owned é','0.1.0','darwin').resources,join('/owned é','Open RotMG Single Player.app/Contents/Resources'));
 assert.equal(installedPaths('/owned é','0.1.0','linux').resources,join('/owned é','resources'));
});
test('installer maker precheck refuses a source preview or unsigned release metadata, without a production-key fixture',async()=>{
 await mkdir('.qa/unit',{recursive:true});const root=await mkdtemp(resolve('.qa/unit/installer-check-'));await mkdir(join(root,'dist'));await writeFile(join(root,'package.json'),JSON.stringify({version:'0.1.0'}));
 for(const baseline of [{mode:'source'},{mode:'release',manifest:Buffer.from('{}').toString('base64'),signature:Buffer.alloc(64).toString('base64')}]){
  await writeFile(join(root,'dist/runtime-baseline.json'),JSON.stringify(baseline));const result=spawnSync(process.execPath,[resolve('scripts/installer-inputs.mjs'),'check'],{cwd:root,encoding:'utf8'});assert.notEqual(result.status,0);assert.match(result.stderr,baseline.mode==='source'?/never a source preview/:/signature/i);
 }
});
test('offline installer workflow is manual, native-only, read-only and never signs/publishes or rebuilds runtime',async()=>{
 const workflow=await readFile('.github/workflows/offline-installers.yml','utf8'),producer=await readFile('scripts/installer-inputs.mjs','utf8'),verifier=await readFile('scripts/verify-installer.mjs','utf8');
 assert(workflow.includes('workflow_dispatch:'));assert(workflow.includes('[ubuntu-22.04, windows-2022, macos-15]'));assert(workflow.includes('contents: read'));assert(workflow.includes('actions: read'));assert(workflow.includes('persist-credentials: false'));
 for(const text of [workflow,producer])assert(!/RUNTIME_MANIFEST_SIGNING_KEY|secrets\.|contents: write|release upload|release create|cargo |ci-inputs\.mjs|ci-runtime-inputs\.mjs|releases\/latest/.test(text));
 assert(workflow.includes('actions/upload-artifact@'));assert(workflow.includes('npm run verify:release'));
 assert(producer.includes('runtimeRelease:{manifest,signature,archive}'));assert(producer.includes('MANIFEST_PUBLIC_KEY'));
 assert(verifier.includes("'installer-result.json'"));assert(!verifier.includes("'result.json'"));assert(!verifier.includes('out/Open RotMG'));
 assert(verifier.includes('verifyRuntime(selected,targetName(),manifest)'));assert(verifier.includes('nativeGame('));assert(verifier.includes('productionPolicy(resources,launcher)'));assert(verifier.includes('status:503'));
 assert(!/--no-sandbox|--disable-web-security|--enable-unsafe-swiftshader/.test(workflow));
});
