import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile,readdir,realpath,readlink} from 'node:fs/promises';
import {resolve,join,dirname,basename} from 'node:path';
import {release,version as osVersion} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {hashFile,targetName} from '../dist/update-format.js';
import {launchUpdateTest} from './test-launch.mjs';
import {updateTestDisplay} from './test-display.mjs';
import {consumerEnvironment,runtimeLinkage} from './native-boundaries.mjs';
import {verifyLegacyLauncher} from './verify-legacy-launcher.mjs';
import {verifyLauncherUpdate} from './verify-launcher-update.mjs';
import {nativeGame} from './native-game.mjs';
import {installedPaths,installArtifact} from './installer-install.mjs';

// Plays the extracted release ZIP like a player: no network, no installs, then updates from older launchers.
assert.equal(process.argv.length,3,'npm run verify:release -- ARTIFACT (with adjacent installer-receipt.json)');
if(process.platform==='linux'&&!process.env.OPENROTMG_PRIVATE_INSTALLER_TEST){
 const child=spawn('dbus-run-session',[process.execPath,...process.argv.slice(1)],{stdio:'inherit',env:{...process.env,OPENROTMG_PRIVATE_INSTALLER_TEST:'1'}});child.on('exit',code=>process.exitCode=code??1);
}else{await journey();if(process.exitCode)process.exit(process.exitCode);}
async function journey(){
 await mkdir('.qa/installer-tests',{recursive:true});const out=await mkdtemp(resolve('.qa/installer-tests/run-'));
 const report={format:1,status:'running',os:{platform:process.platform,arch:process.arch,release:release(),version:osVersion()},out,assertions:[],errors:[],screenshots:[],limits:['Unsigned binaries; no Authenticode/notarization. The ZIP is extracted without downloaded quarantine or Mark-of-the-Web.']};
 const check=(name,value)=>{assert(value,name);report.assertions.push(name);console.log('PASS '+name);};
 const persist=()=>writeFile(join(out,'installer-result.json'),JSON.stringify(report,null,2)+'\n');
 const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
 const wait=async(predicate,label,timeout=60000)=>{const end=Date.now()+timeout;do{if(await predicate())return;await delay(100);}while(Date.now()<end);throw Error('Timed out: '+label);};
 let app,page,display,game;
 try{
  const artifact=resolve(process.argv[2]),receipt=JSON.parse(await readFile(join(dirname(artifact),'installer-receipt.json'),'utf8'));
  assert.equal(receipt.target,targetName());assert.equal(receipt.installer.name,basename(artifact));assert.equal(await hashFile(artifact),receipt.installer.sha256);
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),receipt.installerSourceHead);
  report.delivery=receipt;
  const flags=JSON.parse(process.env.PI_NATIVE_TEST_CHROME_ARGS??'[]');assert(flags.length===0||JSON.stringify(flags)==='["--ignore-gpu-blocklist"]','Only approved software WebGL flag allowed');
  display=await updateTestDisplay(out);report.display=display.proof;
  const env=await consumerEnvironment(display.env,out),installation=join(out,'extracted Open RotMG é 日本');
  report.installation=await installArtifact(artifact,installation,out);const paths=installedPaths(report.installation.path),root=report.installation.path,storage=join(root,'server data/profile');
  const runtime=join(paths.resources,'runtime'),binary=join(runtime,process.platform==='win32'?'openrotmg.exe':'openrotmg'),data=join(runtime,'data');
  const identity=JSON.parse(await readFile(join(runtime,'build-identity.json'),'utf8'));
  check('The ZIP bundles the pinned server, client and Ruffle WASM, so nothing else is downloaded or installed',JSON.stringify(identity.pins)===JSON.stringify(receipt.pins)&&(await readdir(join(runtime,'client/vendor'),{recursive:true})).some(name=>name.endsWith('.wasm'))&&(await readdir(join(runtime,'client'))).includes('client.swf'));
  report.linkage=runtimeLinkage(binary);check('The bundled server needs only operating-system libraries',true);
  const fixtureState=join(out,'synthetic donor'),portable=join(out,'exported account.json');
  execFileSync(binary,['--backup-fixture',fixtureState,data],{env,timeout:30000});execFileSync(binary,['--local-save','export',fixtureState,data,'1',portable],{env,timeout:30000});
  const launch=async()=>{
   // Any attempt to leave this computer fails the test: the game must work offline and only check for updates on request.
   ({app}=await launchUpdateTest({executablePath:paths.launcher,electronPath:paths.executable,profile:storage,env,policy:{},setupMain:`globalThis.offlineAttempts=[];const original=globalThis.fetch;globalThis.fetch=async(url,...rest)=>{const value=String(url);if(!/^http:\\/\\/127\\.0\\.0\\.1:/.test(value)){globalThis.offlineAttempts.push(value);throw new TypeError('Offline test refused '+value);}return original(url,...rest);};`}));
   page=await app.firstWindow();await page.waitForFunction(()=>!!window.launcher);await wait(async()=>(await page.locator('#play').isEnabled()),'launcher ready');
  };
  const offlineAttempts=()=>app.evaluate(()=>globalThis.offlineAttempts);
  const choose=(path,confirm)=>app.evaluate((_electron,{path,confirm})=>{const f=globalThis.runtimeUpdateTest;if(path!==undefined){f.allowedFiles.push(path);f.choices.push(path);}if(confirm!==undefined)f.confirms.push(confirm);},{path,confirm});
  const status=()=>page.evaluate(()=>window.launcher.status());
  const backups=async()=>(await readdir(join(paths.player,'backups'))).filter(name=>name.endsWith('.sqlite'));
  const play=async()=>{
   await page.locator('#show-home').click();await page.locator('#play').click();
   await wait(async()=>{const view=await status();assert.notEqual(view.status,'failed',view.message);return view.status==='ready';},'bundled server ready',650000);
   const view=await status(),image=process.platform==='linux'?await readlink(`/proc/${view.pid}/exe`):binary;
   check('Play starts the server bundled inside the extracted folder',await realpath(image)===await realpath(binary));
   return view;
  };
  const close=async()=>{const view=await status(),main=app.process().pid,closed=app.waitForEvent('close');await page.locator('#close-window').click();assert.equal((await closed).code,0);assert(!alive(main));if(view.pid)assert(!alive(view.pid));await app.detach();app=undefined;};
  await launch();
  check('Home shows one Play button with no installed-version variant or caption under the portal',await page.locator('#play').innerText()==='Play'&&await page.locator('#home-page').innerText().then(text=>!/Enter your own realm|installed/i.test(text)));
  check('Home tools are Import account, Backups and Updates',JSON.stringify(await page.locator('.shortcuts button').allInnerTexts())===JSON.stringify(['Import account','Backups','Updates']));
  await page.screenshot({path:join(out,'launcher-home.png')});
  await page.locator('#show-settings').click();await page.locator('#tab-updates').click();
  check('Updates has one manual check and no separate server or client install',await page.locator('#updates-page').innerText().then(text=>!/Server \+ client|Install/i.test(text))&&await page.locator('#check-launcher').isEnabled());
  await page.screenshot({path:join(out,'launcher-updates.png')});
  check('Importing before the first Play explains how to make the required backup',/Click Play once/.test(await page.evaluate(()=>window.launcher.importPlayer().then(()=>'',error=>error.message))));
  await play();
  check('Every start makes a verified full backup before opening the save',(await backups()).some(name=>name.includes('-pre-start-')));
  await page.locator('#import').click();await wait(async()=>await page.locator('#accounts-import').isEnabled(),'accounts ready');
  await choose(portable);await page.locator('#accounts-import').click();await page.locator('#import-preview').waitFor({state:'visible'});
  check('Import keeps the editable default password',await page.locator('#import-password').inputValue()==='password');
  const login=await page.locator('#local-login').innerText();
  await page.locator('#import-confirm').click();await wait(async()=>/Account imported/.test(await page.locator('#accounts-status').innerText()),'import completes');
  check('Import made a verified backup first and lists the imported account',(await backups()).some(name=>name.includes('-pre-import-'))&&await page.locator('#account-list form').count()>=1);
  await page.screenshot({path:join(out,'launcher-accounts.png')});
  const before=await play();
  game=await nativeGame({out,origin:new URL(before.clientURL).origin,clientURL:before.clientURL,env,check,report,credentials:{guid:login,password:'password'}});await game.mutate();
  check('The game page made no request outside this computer',!report.blockedBrowserRequests?.length);
  await game.close();
  await page.locator('#tab-backups').click();const count=(await backups()).length;await page.locator('#backup').click();await wait(async()=>(await backups()).length===count+1,'manual backup');
  check('Back up now writes a full local backup',true);
  await page.locator('#tab-advanced').click();await page.locator('#bots-enabled').check();await wait(async()=>(await status()).botsEnabled,'bots enabled');
  check('Local bots are off by default and the setting is saved explicitly',JSON.parse(await readFile(join(storage,'launcher-settings.json'),'utf8')).bots===true);
  await page.locator('#bots-enabled').uncheck();await wait(async()=>!(await status()).botsEnabled,'bots disabled');
  await page.screenshot({path:join(out,'launcher-advanced.png')});
  check('Opening the launcher, playing, importing and backing up never touched the network',(await offlineAttempts()).length===0);
  await close();
  await launch();const reopened=await play();await game.verify(false,reopened.clientURL);
  check('Reopening the same folder keeps character progress offline',(await offlineAttempts()).length===0);
  await close();
  await verifyLauncherUpdate({paths,env,out,report,check,verifyProgress:url=>game.verify(true,url),closeGame:()=>game.close()});
  await verifyLegacyLauncher({artifact,env,out,report,check});
  report.status='passed';
 }catch(error){report.status='failed';report.errors.push(String(error.stack??error));process.exitCode=1;console.error(error);try{await page?.screenshot({path:join(out,'failure.png')});}catch{}}
 finally{try{await game?.close();}catch{}try{if(app)await app.close();}catch{}await display?.close();await persist();}
}
