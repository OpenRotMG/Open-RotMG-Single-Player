import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile,readdir,stat,realpath,readlink,rename,rmdir} from 'node:fs/promises';
import {resolve,join,dirname,basename} from 'node:path';
import {release,version as osVersion} from 'node:os';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {extractFile} from '@electron/asar';
import {hashFile,targetName,verifyManifest,verifyRuntime} from '../dist/update-format.js';
import {MANIFEST_PUBLIC_KEY} from '../dist/update-policy.js';
import {launchUpdateTest} from './runtime-update-test-launch.mjs';
import {updateTestDisplay} from './runtime-update-test-display.mjs';
import {consumerEnvironment,protectInstallation,assertInstallationProtected,runtimeLinkage,windowsProcessIdentity} from './native-boundaries.mjs';
import {nativeGame} from './native-game.mjs';
import {processArgv} from './process-argv.mjs';
import {acquireQaPortLease} from './qa-port.mjs';
import {packagedChildReady} from './package-readiness.mjs';
import {installedPaths,installArtifact} from './installer-install.mjs';
import {assertWindowsInstallerWriteDenied} from './installer-write-probe.mjs';

assert.equal(process.argv.length,3,'npm run verify:release -- ARTIFACT (with adjacent installer-receipt.json)');
if(process.platform==='linux'&&!process.env.OPENROTMG_PRIVATE_INSTALLER_TEST){
 const child=spawn('dbus-run-session',[process.execPath,...process.argv.slice(1)],{stdio:'inherit',env:{...process.env,OPENROTMG_PRIVATE_INSTALLER_TEST:'1'}});child.on('exit',code=>process.exitCode=code??1);
}else await journey();
async function journey(){
 await mkdir('.qa/installer-tests',{recursive:true});const out=await mkdtemp(resolve('.qa/installer-tests/run-'));
 const report={format:1,status:'running',os:{platform:process.platform,arch:process.arch,release:release(),version:osVersion()},out,assertions:[],errors:[],screenshots:[],limits:['Unsigned binaries; no Authenticode/notarization. The ZIP is extracted without downloaded quarantine or Mark-of-the-Web, so Gatekeeper/SmartScreen prompts are not qualified','Normal-cache browser requests are uncontrolled; only update availability is controlled (HTTP 503); NOT OS-wide offline or default-browser/hardware qualification','Synthetic exported account and explicit native chooser/confirmation fixtures; real installed Rust save authority and native game','Owned hosted runner user only; not a clean non-administrator machine or removal of every installed developer tool']};
 const check=(name,value)=>{assert(value,name);report.assertions.push(name);console.log('PASS '+name);};
 const persist=()=>writeFile(join(out,'installer-result.json'),JSON.stringify(report,null,2)+'\n');
 const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
 const wait=async(predicate,label,timeout=60000)=>{const end=Date.now()+timeout;do{if(await predicate())return;await delay(100);}while(Date.now()<end);throw Error('Timed out: '+label);};
 let app,page,display,lease,game,restoreProtection,serverPid;
 try{
  const artifact=resolve(process.argv[2]),receipt=JSON.parse(await readFile(join(dirname(artifact),'installer-receipt.json'),'utf8'));
  assert.equal(receipt.target,targetName());assert.equal(receipt.installer.name,basename(artifact));assert.equal(await hashFile(artifact),receipt.installer.sha256);
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),receipt.installerSourceHead);assert.equal(execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim(),'');
  report.delivery=receipt;report.artifact={path:artifact,sha256:await hashFile(artifact)};
  const flags=JSON.parse(process.env.PI_NATIVE_TEST_CHROME_ARGS??'[]');assert(flags.length===0||JSON.stringify(flags)==='["--ignore-gpu-blocklist"]','Only approved software WebGL flag allowed');
  lease=await acquireQaPortLease();display=await updateTestDisplay(out);report.display=display.proof;
  const env=await consumerEnvironment(display.env,out),installation=join(out,'extracted Open RotMG é 日本');let paths,profile,resources,executable,runtime;
  const use=root=>{paths=installedPaths(root);({player:profile,resources,executable}=paths);runtime=join(resources,'runtime');};
  report.installations=[await installArtifact(artifact,installation,out)];use(report.installations[0].path);
  const launcherVersion=JSON.parse(await readFile('package.json','utf8')).version,binary=join(runtime,process.platform==='win32'?'openrotmg.exe':'openrotmg'),data=join(runtime,'data');
  const config=JSON.parse(extractFile(join(resources,'app.asar'),'dist/runtime-baseline.json').toString());assert.equal(config.mode,'release');
  const manifest=verifyManifest(Buffer.from(config.manifest,'base64'),Buffer.from(config.signature,'base64'),MANIFEST_PUBLIC_KEY,receipt.releaseId,receipt.tag,targetName(),launcherVersion,'https://github.com');
  assert(manifest.sequence>0);assert.equal(manifest.sequence,receipt.sequence);assert.equal(manifest.payload.sha256,receipt.runtimeArchive.sha256);assert.deepEqual(manifest.pins,receipt.pins);assert.equal(config.identitySha256,manifest.payload.identitySha256);
  report.baseline=manifest;report.runtime=await verifyRuntime(runtime,targetName(),manifest);report.linkage=runtimeLinkage(binary);report.installed={installation,launcher:paths.launcher,executable,resources,launcherSha256:await hashFile(paths.launcher),executableSha256:await hashFile(executable),asarSha256:await hashFile(join(resources,'app.asar'))};
  const assertProtected=async phase=>{
   if(process.platform!=='win32')return assertInstallationProtected(paths.server,runtime);
   const proof=await assertWindowsInstallerWriteDenied(paths.server,runtime,out,phase);(report.windowsWriteProbes??=[]).push(proof);
  };
  restoreProtection=await protectInstallation(paths.server);await assertProtected('install');
  check('ZIP extracts into one OpenRotMG Singleplayer folder containing the launcher, README.txt, empty player data and server data; its signed runtime baseline matches the delivery archive and pins',true);
  const fixtureState=join(out,'synthetic donor'),portable=join(out,'exported account.json');
  execFileSync(binary,['--backup-fixture',fixtureState,data],{env,timeout:30000});execFileSync(binary,['--local-save','export',fixtureState,data,'1',portable],{env,timeout:30000});
  const secret=randomBytes(24).toString('base64url');let userData;
  const launch=async()=>{
   // Keep the real embedded production policy and key; only service availability is controlled in the owned main inspector.
   ({app}=await launchUpdateTest({executablePath:paths.launcher,electronPath:executable,profile,env,policy:{},setupMain:"module.createUpdatePolicy=(resources,launcher)=>({...productionPolicy(resources,launcher),request:async()=>new Response('',{status:503})});"}));
   page=await app.firstWindow();await page.waitForFunction(()=>!!window.launcher);await wait(async()=>(await page.evaluate(()=>window.launcher.updates())).phase==='service','controlled update service refusal');
   userData=await app.evaluate(({app})=>app.getPath('userData'));assert.equal(userData,profile);report.userData=userData;
   assert.equal(await app.evaluate(()=>process.resourcesPath),resources);assert.equal(await app.evaluate(()=>process.execPath),executable);
   assert.equal(await app.evaluate(()=>process.env.PATH),env.PATH);assert(!(await app.evaluate(()=>process.env.NODE_OPTIONS)));
   const pid=await app.evaluate(()=>process.pid),argv=await processArgv(pid);assert(!argv.includes('--no-sandbox'));
   const prefs=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());assert(prefs.sandbox&&prefs.contextIsolation&&!prefs.nodeIntegration&&prefs.webSecurity);
   (report.launches??=[]).push({pid,argv,userData});
  };
  const choose=async(path,confirm)=>app.evaluate((_electron,{path,confirm})=>{const f=globalThis.runtimeUpdateTest;f.allowedFiles.push(path);f.choices.push(path);if(confirm!==undefined)f.confirms.push(confirm);},{path,confirm});
  const start=async()=>{
   await page.locator('#show-settings').click();
   await page.locator('#play-installed').click();
   await page.locator('#show-home').click();await wait(async()=>packagedChildReady(await page.evaluate(()=>window.launcher.status())),'actual installed child readiness',650000);
   const view=await page.evaluate(()=>window.launcher.status()),health=await(await fetch(view.origin+'/health')).json();serverPid=view.pid;assert.equal(health.process,serverPid);
   const selection=JSON.parse(await readFile(join(profile,'runtime-selection.json'),'utf8')),selected=join(profile,'runtimes',selection.id,'runtime');await verifyRuntime(selected,targetName(),manifest);
   const image=process.platform==='linux'?await readlink(`/proc/${serverPid}/exe`):process.platform==='win32'?windowsProcessIdentity(serverPid).executable:execFileSync('ps',['-p',String(serverPid),'-o','comm='],{encoding:'utf8'}).trim();
   assert.equal(await realpath(image),await realpath(join(selected,process.platform==='win32'?'openrotmg.exe':'openrotmg')));assert.equal(await hashFile(image),manifest.payload.binarySha256);
   const argv=await processArgv(serverPid);assert(argv.includes('--desktop')&&!/--dev-control|--test-state/.test(argv));
   (report.processes??=[]).push({pid:serverPid,image,health,argv,selection,binarySha256:await hashFile(image)});return view;
  };
  const stop=async()=>{const pid=serverPid;await page.locator('#stop').click();await wait(async()=>(await page.evaluate(()=>window.launcher.status())).status==='stopped','durable Stop',650000);assert(!alive(pid));serverPid=undefined;const logs=(await readdir(join(profile,'diagnostics'))).sort();assert((await readFile(join(profile,'diagnostics',logs.at(-1)),'utf8')).includes('shutdown persistence complete'));};
  const close=async()=>{const pid=serverPid,main=app.process().pid,result=await app.close();assert.equal(result.code,0);assert(!alive(main));if(pid)assert(!alive(pid));app=undefined;serverPid=undefined;};
  await launch();
  check('Home starts with settings and logs on separate pages and a top-right gear',await page.locator('#home-page').isVisible()&&await page.locator('#settings-page').isHidden()&&await page.locator('#logs-page').isHidden()&&await page.locator('#show-settings').getAttribute('aria-label')==='Settings');
  await page.screenshot({path:join(out,'launcher-home.png')});
  await page.locator('#show-logs').click();
  check('Detailed log path lives only on the Server logs page',await page.locator('#logs-page').isVisible()&&await page.locator('#diagnostics').innerText()==='Detailed logs: '+join(profile,'diagnostics'));
  await page.screenshot({path:join(out,'launcher-logs.png')});
  await page.locator('#show-settings').click();
  check('Settings shows numbered source commits instead of full hashes',/Server commit #2542 · Client commit #88/.test(await page.locator('#update-installed').innerText()));
  await page.screenshot({path:join(out,'launcher-settings.png')});
  await choose(portable);await page.locator('#import').click();await page.locator('#import-preview').waitFor({state:'visible'});const login=await page.locator('#local-login').inputValue();await page.locator('#password').fill(secret);await page.locator('#confirmation').fill(secret);await page.locator('#import-confirm').click();await page.locator('#import-preview').waitFor({state:'hidden',timeout:60000});assert.equal(await page.locator('#error').innerText(),'');
  let view=await start();
  assert.equal(await page.locator('#client-url').getAttribute('href'),new URL(view.clientURL).origin+'/');
  await page.screenshot({path:join(out,'launcher-ready.png')});
  game=await nativeGame({out,origin:new URL(view.clientURL).origin,clientURL:view.clientURL,env,check,report,normalCache:true,credentials:{guid:login,password:secret}});await game.mutate();await stop();await game.close();
  check('Installed native game import, real progress transaction and durable Stop verified',true);
  await page.locator('#show-settings').click();
  await page.locator('#backup').click();await wait(async()=>/Verified full local backup/.test(await page.locator('#save-result').innerText()),'full backup');
  const backups=join(profile,'backups'),names=(await readdir(backups)).filter(n=>n.includes('-manual-')&&n.endsWith('.sqlite'));assert.equal(names.length,1);const backup=join(backups,names[0]);
  report.backup={path:backup,sha256:await hashFile(backup),bytes:(await stat(backup)).size};
  await choose(backup,1);await page.locator('#restore').click();await wait(async()=>/Full local save restored/.test(await page.locator('#save-result').innerText()),'full restore');
  await close();await launch();await start();await game.verify(true);await close();await game.close();
  check('Full backup/restore, cold reopen and active-game Close preserve progress without orphan processes',true);
  const stateHash=await hashFile(join(profile,'state/game.db'));await restoreProtection();restoreProtection=undefined;
  const replacement=join(out,'new copy Open RotMG é 日本');report.installations.push(await installArtifact(artifact,replacement,out));
  const replacementRoot=report.installations.at(-1).path;
  await rmdir(join(replacementRoot,'player data'));await rename(profile,join(replacementRoot,'player data'));use(replacementRoot);
  assert.equal(await hashFile(join(profile,'state/game.db')),stateHash);assert.equal(await hashFile(join(resources,'app.asar')),report.installed.asarSha256);await verifyRuntime(runtime,targetName(),manifest);
  restoreProtection=await protectInstallation(paths.server);await assertProtected('reinstall');await launch();await start();await game.verify(true);await stop();await game.close();game=undefined;await close();
  check('A fresh extraction with the moved player data folder keeps the identical database and real playable saved progress',true);
  report.status='passed';
 }catch(error){if(error.windowsWriteProbe)(report.windowsWriteProbes??=[]).push(error.windowsWriteProbe);report.errors.push(String(error.stack??error));report.status='failed';process.exitCode=1;}
 finally{
  for(const [name,cleanup] of [['browser',()=>game?.close()],['launcher',()=>app?.close()],['install protection',()=>restoreProtection?.()],['display',()=>display?.close()],['port lease',()=>lease?.release()]])try{await cleanup();}catch(error){report.errors.push(`${name}: ${error.stack??error}`);}
  if(serverPid&&alive(serverPid))report.errors.push(`Owned server ${serverPid} remains alive; NOT force-killed, no save success claimed`);
  if(report.errors.length){report.status='failed';process.exitCode=1;}await persist();console.log(`${report.status}: ${join(out,'installer-result.json')}`);for(const error of report.errors)console.error(error);
 }
}
