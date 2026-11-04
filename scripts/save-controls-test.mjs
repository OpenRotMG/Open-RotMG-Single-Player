import {_electron as electron} from '@playwright/test';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile,readdir,chmod,cp,stat,readlink,lstat} from 'node:fs/promises';
import {join,resolve,isAbsolute} from 'node:path';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {sha256,tree} from './assets.mjs';
import {protectInstallation,assertInstallationProtected} from './native-boundaries.mjs';
import {acquireQaPortLease} from './qa-port.mjs';
import {nativeGame} from './native-game.mjs';
import {processArgv} from './process-argv.mjs';

assert.deepEqual(process.argv.slice(2),['--project=desktop'],'Run npm run test:e2e -- --project=desktop');
assert.equal(process.platform,'linux','This focused save journey currently qualifies Linux x64 only');
assert.equal(process.arch,'x64');
if(!process.env.OPENROTMG_PRIVATE_SAVE_TEST){
 const child=spawn('dbus-run-session',[process.execPath,...process.argv.slice(1)],{stdio:'inherit',env:{...process.env,OPENROTMG_PRIVATE_SAVE_TEST:'1'}});
 child.on('exit',code=>process.exitCode=code??1);
}else await journey();

async function journey(){
 await mkdir('.qa/save-tests',{recursive:true});
 const out=await mkdtemp(resolve('.qa/save-tests/run-'));
 const report={status:'running',out,checks:[],errors:[],screenshots:[],limits:['Linux x64 QA-enabled software WebGL only; not default GPU, default browser, OS offline, Windows/macOS or installers','Native chooser and restore-confirmation use declared per-run main-process dialog fixtures; real Rust authority and packaged renderer, not mocked save success','Open backup folder uses real shell.openPath and a fresh privately installed PCManFM in an isolated bus/display; not the host/default file manager']};
 let launcher,page,display,lease,game,folderManagerPid;
 const persist=()=>writeFile(join(out,'result.json'),JSON.stringify(report,null,2));
 const check=(name,value)=>{assert(value,name);report.checks.push(name);console.log('PASS '+name);};
 const screenshot=async name=>{const path=join(out,name+'.png');await page.screenshot({path,fullPage:true});report.screenshots.push(path);};
 const run=async(file,args,input)=>{
  const child=spawn(file,args,{cwd:out,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const closed=new Promise((ok,bad)=>{child.once('error',bad);child.once('close',(code,signal)=>ok({code,signal}));});
  child.stdin.end(input);const result=await closed;assert.equal(result.code,0,`${file} ${args[0]} failed: ${stderr}`);assert.equal(result.signal,null);return stdout;
 };
 try{
  assert.equal(process.env.OPENROTMG_TEST_BROWSER_MODE,'vps-managed');assert.deepEqual(JSON.parse(process.env.PI_NATIVE_TEST_CHROME_ARGS??'[]'),['--ignore-gpu-blocklist'],'Only the approved VPS QA software-WebGL flag is permitted');
  const fixture=process.env.OPENROTMG_SAVE_FIXTURE,fixtureHash=process.env.OPENROTMG_SAVE_FIXTURE_SHA256;
  assert(fixture&&isAbsolute(fixture)&&/^[a-f0-9]{64}$/.test(fixtureHash),'Explicit real Phase3 download path and SHA256 required');
  const bytes=await readFile(fixture);assert.equal(sha256(bytes),fixtureHash);
  report.fixture={path:fixture,sha256:fixtureHash,bytes:bytes.length};
  const selected=join(out,'selected-account.json');await writeFile(selected,bytes,{mode:0o600});
  const pins=JSON.parse(await readFile('source-pins.json','utf8'));
  report.launcher={head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),tree:execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()!==''};
  assert.equal(report.launcher.dirty,false,'Package journey requires clean committed launcher source');
  lease=await acquireQaPortLease();
  const tmpRoot=process.env.OPENROTMG_TEST_TMP_ROOT;assert(tmpRoot&&isAbsolute(tmpRoot),'Explicit short owned on-disk TMPDIR root required');await mkdir(tmpRoot,{recursive:true});
  const tmp=await mkdtemp(join(tmpRoot,'save-'));assert(Buffer.byteLength(tmp)<65);report.tmp=tmp;
  const env={...process.env,TMPDIR:tmp,TEMP:tmp,TMP:tmp,XDG_CONFIG_HOME:join(out,'config'),XDG_CACHE_HOME:join(out,'cache'),XDG_DATA_HOME:join(out,'data')};delete env.WAYLAND_DISPLAY;delete env.NODE_OPTIONS;
  Object.assign(process.env,{TMPDIR:tmp,TEMP:tmp,TMP:tmp});
  const xauth=join(out,'Xauthority'),cookie=randomBytes(16).toString('hex');await writeFile(xauth,'',{mode:0o600});execFileSync('xauth',['-f',xauth,'add',':99','MIT-MAGIC-COOKIE-1',cookie]);
  display=spawn('Xvfb',['-displayfd','3','-screen','0','1400x1100x24','-nolisten','tcp','-auth',xauth],{stdio:['ignore','ignore','pipe','pipe']});let number='';display.stdio[3].on('data',b=>number+=b);
  await wait(()=>number.includes('\n'),'private display',10000);env.DISPLAY=':'+number.trim();env.XAUTHORITY=xauth;execFileSync('xauth',['-f',xauth,'add',env.DISPLAY,'MIT-MAGIC-COOKIE-1',cookie]);
  const managerPrefix=process.env.OPENROTMG_TEST_FILE_MANAGER_PREFIX;assert(managerPrefix&&isAbsolute(managerPrefix),'Explicit owned real PCManFM prefix required; no fake handler or host manager');
  assert(env.DBUS_SESSION_BUS_ADDRESS&&!env.DBUS_SESSION_BUS_ADDRESS.includes('/run/user/'),'A private dbus-run-session bus is required for OS folder dispatch');
  Object.assign(env,{PATH:join(managerPrefix,'usr/bin')+':'+env.PATH,LD_LIBRARY_PATH:join(managerPrefix,'usr/lib/x86_64-linux-gnu'),XDG_DATA_DIRS:join(managerPrefix,'usr/share')+':/usr/local/share:/usr/share',XDG_CURRENT_DESKTOP:''});
  for(const key of ['XDG_SESSION_DESKTOP','DESKTOP_SESSION','KDE_FULL_SESSION','GNOME_DESKTOP_SESSION_ID'])delete env[key];
  await mkdir(env.XDG_CONFIG_HOME,{recursive:true});await writeFile(join(env.XDG_CONFIG_HOME,'mimeapps.list'),'[Default Applications]\ninode/directory=pcmanfm.desktop\n');
  const managerBinary=join(managerPrefix,'usr/bin/pcmanfm');report.folderManager={binary:managerBinary,sha256:sha256(await readFile(managerBinary)),associationScope:env.XDG_CONFIG_HOME,bus:env.DBUS_SESSION_BUS_ADDRESS,display:env.DISPLAY};
  const installation=join(out,'installed runtime with spaces');await cp(resolve('out/Open RotMG Single Player-linux-x64'),installation,{recursive:true,verbatimSymlinks:true});
  const native=join(installation,'openrotmg-single-player'),resources=join(installation,'resources/runtime'),binary=join(resources,'openrotmg'),data=join(resources,'data');
  const build=JSON.parse(await readFile(join(resources,'build-identity.json'),'utf8'));assert.deepEqual(build.pins,pins);assert.equal(sha256(await readFile(binary)),build.binarySha256);assert.equal((await readFile(join(resources,'REVISION'),'utf8')).trim(),pins.server.commit);
  const input=JSON.parse(await readFile(process.env.OPENROTMG_BUILD_INPUTS,'utf8')),receiptBytes=await readFile(input.serverBuildReceipt),receipt=JSON.parse(receiptBytes);
  assert.equal(sha256(receiptBytes),build.buildReceiptSha256);assert.equal(receipt.head,pins.server.commit);assert.equal(receipt.dirty,false);assert.equal(receipt.sha256,build.binarySha256);
  for(const [path,pin] of [[input.serverSource,pins.server.commit],[input.clientSource,pins.client.commit]]){assert.equal(execFileSync('git',['-C',path,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),pin);assert.equal(execFileSync('git',['-C',path,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim(),'');}
  report.build={identity:build,receipt,binary,actualBinarySha256:sha256(await readFile(binary)),appAsarSha256:sha256(await readFile(join(installation,'resources/app.asar')))};
  const installedBefore=await tree(resources,['data','client','notices','openrotmg','REVISION','inventory.json','build-identity.json']);await protectInstallation(installation);await assertInstallationProtected(installation,resources);
  const cli=async(command,args,secret)=>JSON.parse(await run(binary,['--local-save',command,...args],secret));
  const fingerprint=async state=>JSON.parse(await run('python3',[resolve('scripts/save-state.py'),join(state,'game.db')]));
  let profile=join(out,'launcher-profile'),user,state;
  const launch=async()=>{
   launcher=await electron.launch({executablePath:native,args:[`--user-data-dir=${profile}`,'--ozone-platform=x11'],chromiumSandbox:true,env,timeout:30000});
   page=await launcher.firstWindow();await page.waitForFunction(()=>!!window.launcher);user=await launcher.evaluate(({app})=>app.getPath('userData'));state=join(user,'state');
   assert(user.startsWith(out)&&!user.startsWith(installation));if(!(report.userDataDirectories??=[]).includes(user))report.userDataDirectories.push(user);
   const argv=await processArgv(await launcher.evaluate(()=>process.pid));assert(!argv.includes('--no-sandbox'));
   const preferences=await launcher.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());assert(preferences.sandbox&&preferences.contextIsolation&&!preferences.nodeIntegration);
   // Only this attached test process declares chooser paths. No test IPC/path override ships in the app.
   await launcher.evaluate(({dialog,shell},allowed)=>{
    globalThis.saveTest={allowed,choices:[],confirms:[],events:[]};
    dialog.showOpenDialog=async(_window,options)=>{const fixture=globalThis.saveTest,chosen=fixture.choices.shift();if(chosen===undefined)throw Error('No declared chooser fixture');fixture.events.push({kind:'choose',title:options.title,chosen});if(chosen===null)return{canceled:true,filePaths:[]};if(!fixture.allowed.includes(chosen))throw Error('Undeclared chooser path');return{canceled:false,filePaths:[chosen]};};
    const originalMessage=dialog.showMessageBox;dialog.showMessageBox=async(window,options)=>{if(options.title!=='Replace the full local save?')return originalMessage(window,options);const fixture=globalThis.saveTest,response=fixture.confirms.shift();if(response===undefined)throw Error('No declared restore confirmation');fixture.events.push({kind:'restore-confirm',options,response});return{response};};
    const originalOpen=shell.openPath;shell.openPath=async path=>{const result=await originalOpen(path);globalThis.saveTest.events.push({kind:'open-folder',path,result});return result;};
   },[selected]);
   return page;
  };
  const choice=async path=>launcher.evaluate((_electron,path)=>{if(path!==null&&!globalThis.saveTest.allowed.includes(path))globalThis.saveTest.allowed.push(path);globalThis.saveTest.choices.push(path);},path);
  const confirm=async response=>launcher.evaluate((_electron,response)=>globalThis.saveTest.confirms.push(response),response);
  const view=()=>page.evaluate(()=>window.launcher.status());
  const expectSuccess=async(action,pattern)=>{await page.locator(action).click();await wait(async()=>pattern.test(await page.locator('#save-result').innerText())||(await page.locator('#error').innerText())!=='','save result',60000);assert.equal(await page.locator('#error').innerText(),'');assert.match(await page.locator('#save-result').innerText(),pattern);};
  const begin=async(path=selected)=>{await choice(path);await page.locator('#import').click();await page.locator('#import-preview').waitFor({state:'visible'});return page.locator('#local-login').inputValue();};
  const commit=async(secret)=>{await page.locator('#password').fill(secret);await page.locator('#confirmation').fill(secret);await page.locator('#import-confirm').click();await page.locator('#import-preview').waitFor({state:'hidden',timeout:60000});assert.equal(await page.locator('#error').innerText(),'');assert.equal(await page.locator('#password').inputValue(),'');};
  const start=async()=>{await page.locator('#start').click();await wait(async()=>(await view()).status==='ready','current packaged server readiness',650000);const v=await view(),health=await(await fetch(v.origin+'/health')).json();assert.equal(health.process,v.pid);assert(!health.bots&&!health.bot_dialogue.enabled);const argv=await processArgv(v.pid);assert(argv.includes('--desktop')&&!argv.includes('--local-save'));assert.equal(await readFile(`/proc/${v.pid}/exe`).then(sha256),build.binarySha256);const names=(await readdir(join(user,'diagnostics'))).sort(),entries=(await readFile(join(user,'diagnostics',names.at(-1)),'utf8')).trim().split('\n').map(line=>JSON.parse(line));const audit=entries.filter(entry=>entry.fields?.record).map(entry=>JSON.parse(entry.fields.record)).find(entry=>entry.kind==='start'&&entry.pid===v.pid);assert(audit);assert.equal(audit.data.revision,pins.server.commit);assert.equal(audit.data.binary_sha256,build.binarySha256);(report.processes??=[]).push({pid:v.pid,argv,health,audit,binarySha256:build.binarySha256});return v;};
  const stop=async()=>{await page.locator('#stop').click();await wait(async()=>(await view()).status==='stopped','verified server stop',650000);assert(!(await view()).pid);const logs=(await readdir(join(user,'diagnostics'))).sort();assert((await readFile(join(user,'diagnostics',logs.at(-1)),'utf8')).includes('shutdown persistence complete'));};
  const accounts=async(login,secret)=>{const response=await fetch('http://127.0.0.1:47831/legacy-api/char/list',{method:'POST',body:new URLSearchParams({guid:login,password:secret})});return response.text();};
  const equipment=xml=>{const result=/<Char id="\d+">[\s\S]*?<Equipment>([^<]*)<\/Equipment>/.exec(xml);assert(result);return result[1].split(',').map(Number);};
  const auth=async(login,good,bad,weapon)=>{const xml=await accounts(login,good);assert(/^(?:<\?xml[^>]*>\s*)?<Chars\b/.test(xml));assert((await accounts(login,bad)).includes('<Error'));assert.equal(equipment(xml)[0],weapon);};
  const passwordA='phase4-independent-local-A',passwordB='phase4-independent-local-B',passwordD='phase4-independent-second-D';
  await launch();await choice(null);await page.locator('#import').click();await wait(async()=>!(await view()).operation,'chooser cancel');assert(!(await stat(state).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;})));check('Native chooser cancellation creates no state or backup',true);
  const login=await begin();assert.equal(login,'player-1@local.invalid');assert.match(await page.locator('#import-summary').innerText(),/exported .*owned characters/);assert(await page.locator('#replace-warning').isHidden());await screenshot('01-import-preview');
  assert.match(await page.locator('#help').getAttribute('title'),/https:\/\/openrotmg.org\/export\//);
  const race=await page.evaluate(async()=>Promise.all([window.launcher.start(),window.launcher.stop(),window.launcher.makeBackup(),window.launcher.restoreBackup(),window.launcher.importPlayer()].map(p=>p.then(()=>false,()=>true))));assert(race.every(Boolean));
  await writeFile(selected,'externally changed after preview');await commit(passwordA);await writeFile(selected,bytes);check('Preview binds private bytes and generated login; concurrent Start/Stop/save actions rejected',true);
  assert(await page.evaluate(()=>localStorage.length===0&&sessionStorage.length===0),'Import credentials must not enter renderer storage');
  const first=await start();await auth(login,passwordA,'backup-fixture-password',2711);check('Imported local credentials are independent; source password rejected by actual packaged server',true);
  game=await nativeGame({out,origin:first.origin,env,check,report,credentials:{guid:login,password:passwordA}});await game.mutate();await stop();await game.close();game=undefined;
  await start();await auth(login,passwordA,'backup-fixture-password',-1);
  game=await nativeGame({out:await newOutput(out,'reopened-native'),origin:first.origin,env,check,report,credentials:{guid:login,password:passwordA}});await stop();await game.close();game=undefined;check('Real imported native play, ordinary drop and durable Stop/reopen persistence',true);
  const secondAccount=JSON.parse(bytes);secondAccount.name='QAFourTwo';secondAccount.name_chosen=true;secondAccount.origin.namespace='e'.repeat(64);await writeFile(selected,JSON.stringify(secondAccount));const secondLogin=await begin();await commit(passwordD);await writeFile(selected,bytes);await start();await auth(secondLogin,passwordD,passwordA,2711);await auth(login,passwordA,passwordD,-1);await stop();
  check('Second independent local account and credentials are present before all eight full backups',true);
  const beforeCancel=await fingerprint(state),backups=join(user,'backups'),beforeNames=await readdir(backups);report.duplicateCancelBefore=beforeCancel;
  await begin();assert(await page.locator('#replace-warning').isVisible());await screenshot('02-replace-warning');await page.locator('#password').fill(passwordA);await page.locator('#confirmation').fill('different-confirmation');await page.locator('#import-confirm').click();await wait(async()=>/passwords must match/.test(await page.locator('#error').innerText()),'mismatched new password refusal');assert.equal(await page.locator('#password').inputValue(),'');assert.equal(await page.locator('#confirmation').inputValue(),'');assert.deepEqual(await fingerprint(state),beforeCancel);assert.deepEqual(await readdir(backups),beforeNames);await page.locator('#import-cancel').click();await wait(async()=>!(await view()).operation,'duplicate cancel');assert.deepEqual(await fingerprint(state),beforeCancel);assert.deepEqual(await readdir(backups),beforeNames);report.duplicateCancelAfter=await fingerprint(state);check('Duplicate-origin replacement cancellation leaves every table/schema and backup list unchanged',true);
  const manual=[];for(let i=0;i<8;i++){await expectSuccess('#backup',/Verified full local backup/);manual.push((await readdir(backups)).filter(x=>x.includes('-manual-')).sort());}
  const manualNames=manual.at(-1);assert.equal(manualNames.length,8);assert.equal(new Set(manualNames).size,8);for(const name of manualNames){const p=join(backups,name),metadata=await cli('verify-snapshot',[p,data]);assert.equal(metadata.scope,'all-local-accounts');assert.equal(metadata.account_count,2);assert.equal((await stat(p)).mode&0o077,0);}
  const older=join(backups,manualNames[0]);await screenshot('03-eight-backups');check('Eight distinct manual snapshots accumulate; every file verifies and preserves full-local scope/credentials',true);
  await page.locator('#folder').click();let folderWindow;
  await wait(()=>{folderWindow=/\b(0x[0-9a-f]+) "backups":.*[Pp]cmanfm/.exec(execFileSync('xwininfo',['-root','-tree'],{env,encoding:'utf8'}));return !!folderWindow;},'real private file-manager folder window',10000);
  const properties=execFileSync('xprop',['-id',folderWindow[1],'_NET_WM_PID','WM_CLASS','_NET_WM_NAME'],{env,encoding:'utf8'}),managerPid=Number(/_NET_WM_PID\(CARDINAL\) = (\d+)/.exec(properties)?.[1]);assert(Number.isSafeInteger(managerPid)&&managerPid>0);
  assert.equal(await readlink(`/proc/${managerPid}/exe`),managerBinary);const managerEnvironment=(await readFile(`/proc/${managerPid}/environ`,'utf8')).split('\0');assert(managerEnvironment.includes('DISPLAY='+env.DISPLAY)&&managerEnvironment.includes('DBUS_SESSION_BUS_ADDRESS='+env.DBUS_SESSION_BUS_ADDRESS));folderManagerPid=managerPid;
  const managerArgv=await readFile(`/proc/${managerPid}/cmdline`,'utf8');assert(managerArgv.includes(backups));report.folderOpen={pid:managerPid,properties,argv:managerArgv.split('\0'),binarySha256:sha256(await readFile(`/proc/${managerPid}/exe`))};
  const folderShot=join(out,'04-real-backup-folder.png');execFileSync('ffmpeg',['-loglevel','error','-f','x11grab','-video_size','1400x1100','-i',env.DISPLAY,'-frames:v','1',folderShot],{env});report.screenshots.push(folderShot);
  process.kill(managerPid,'SIGTERM');await wait(()=>!alive(managerPid),'owned file-manager close',10000);folderManagerPid=undefined;await wait(async()=>/Opened full local backup folder/.test(await page.locator('#save-result').innerText())||!!await page.locator('#error').innerText(),'OS folder result');assert.equal(await page.locator('#error').innerText(),'');check('Real shell.openPath opens the actual backup directory in a fresh private file-manager window',true);
  await begin();await commit(passwordB);const replacementBackup=(await readdir(backups)).filter(x=>x.includes('-pre-replace-'));assert.equal(replacementBackup.length,1);await cli('verify-snapshot',[join(backups,replacementBackup[0]),data]);await start();await auth(login,passwordB,passwordA,2711);await auth(secondLogin,passwordD,passwordA,2711);await stop();check('Explicit duplicate replacement requires verified automatic full backup and changes local password',true);
  const beforeRestore=await fingerprint(state),restoreNames=await readdir(backups);await choice(older);await confirm(0);await page.locator('#restore').click();await wait(async()=>!(await view()).operation,'restore cancellation');assert.deepEqual(await fingerprint(state),beforeRestore);assert.deepEqual(await readdir(backups),restoreNames);
  await choice(older);await confirm(1);await expectSuccess('#restore',/Full local save restored/);const preRestore=(await readdir(backups)).filter(x=>x.includes('-pre-restore-'));assert.equal(preRestore.length,1);await start();await auth(login,passwordA,passwordB,-1);await auth(secondLogin,passwordD,passwordA,2711);await stop();check('Older full restore recovers exact progress and original local password; cancellation unchanged',true);
  await choice(join(backups,preRestore[0]));await confirm(1);await expectSuccess('#restore',/Full local save restored/);await start();await auth(login,passwordB,passwordA,2711);await auth(secondLogin,passwordD,passwordB,2711);await stop();await screenshot('04-restored-credentials');check('Independent pre-restore snapshot recovers the replaced state and its then-current credentials',true);
  const invariant=async(action,label)=>{const before=await fingerprint(state),names=await readdir(backups);await action();const after=await fingerprint(state),afterNames=await readdir(backups);assert.deepEqual(after,before,label+' state');assert.deepEqual(afterNames,names,label+' backups');(report.stateInvariance??=[]).push({label,before,after,backupNames:names});check(label+' leaves all tables/schema and backups unchanged',true);};
  for(const [label,content] of [['malformed','{'],['future',JSON.stringify({...JSON.parse(bytes),format:99})]]){
   await writeFile(selected,content);await invariant(async()=>{await choice(selected);await page.locator('#import').click();await wait(async()=>!(await view()).operation&&!!await page.locator('#error').innerText(),'rejected input');assert.match(await page.locator('#error').innerText(),/failed/);},label+' account');
  }await writeFile(selected,bytes);
  const malformedSnapshot=join(out,'malformed.sqlite'),futureSnapshot=join(out,'future.sqlite');await writeFile(malformedSnapshot,'not SQLite');await cp(older,futureSnapshot);
  await run('python3',['-c','import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute("PRAGMA user_version=99"); db.close()',futureSnapshot]);
  for(const path of [malformedSnapshot,futureSnapshot,join(out,'missing.sqlite')])await invariant(async()=>{await choice(path);await page.locator('#restore').click();await wait(async()=>!(await view()).operation&&!!await page.locator('#error').innerText(),'rejected snapshot');assert.match(await page.locator('#error').innerText(),/failed|ENOENT/);},'invalid/future/missing full snapshot');
  await invariant(async()=>{await choice(join(out,'missing-account.json'));await page.locator('#import').click();await wait(async()=>!(await view()).operation&&!!await page.locator('#error').innerText(),'missing input');assert.match(await page.locator('#error').innerText(),/ENOENT/);},'missing account');
  await begin();await chmod(backups,0o500);try{await invariant(async()=>{await page.locator('#password').fill(passwordA);await page.locator('#confirmation').fill(passwordA);await page.locator('#import-confirm').click();await wait(async()=>!(await view()).operation&&!!await page.locator('#error').innerText(),'backup refusal');assert.match(await page.locator('#error').innerText(),/unchanged.*writable|writable.*unchanged/i);},'unwritable pre-replacement backup');}finally{await chmod(backups,0o700);}assert(await page.locator('#import-preview').isHidden());
  // Competing legitimate CLI changes the next allocated identity after the visible preview.
  const other=JSON.parse(bytes);other.name='QAFourAlt';other.name_chosen=true;other.origin={...other.origin,namespace:'a'.repeat(64)};await writeFile(selected,JSON.stringify(other));await begin();
  const external=join(out,'external-account.json');other.name='QAFourPeer';other.origin.namespace='b'.repeat(64);await writeFile(external,JSON.stringify(other));const externalPreview=await cli('preview',[state,data,external]);await cli('import',[state,data,external,join(backups,'external-cli-pre-import.sqlite'),externalPreview.expected],passwordA);
  await invariant(async()=>{await page.locator('#password').fill(passwordA);await page.locator('#confirmation').fill(passwordA);await page.locator('#import-confirm').click();await wait(async()=>!(await view()).operation&&!!await page.locator('#error').innerText(),'stale preview refusal');assert.match(await page.locator('#error').innerText(),/preview|expect|stale/i);},'external CLI stale-preview rejection');assert(await page.locator('#import-preview').isHidden());await writeFile(selected,bytes);
  other.origin.namespace='c'.repeat(64);await writeFile(selected,JSON.stringify(other));await invariant(async()=>{await choice(selected);await page.locator('#import').click();await wait(async()=>!(await view()).operation&&!!await page.locator('#error').innerText(),'unrelated name collision');assert.match(await page.locator('#error').innerText(),/Destination game save unchanged/);},'unrelated chosen-name collision');await writeFile(selected,bytes);
  // Live mutation path must verify the actual drain before any chooser or save subprocess.
  const live=await start();await begin();assert(!alive(live.pid));assert.equal((await view()).status,'stopped');await page.locator('#import-cancel').click();check('Import requested during a running game verifies real durable exit0 before native chooser/preview',true);
  report.dialogEvents=await launcher.evaluate(()=>globalThis.saveTest.events);
  await launcher.close();launcher=undefined;
  // Explicit crash cuts are QA only: production never force-kills a child to invent a save success.
  profile=join(out,'cut-profile');await launch();await run(binary,['--backup-fixture',state,data]);await cli('restore',[state,data,older,join(out,'cut-setup-pre-restore.sqlite')]);
  const cutAccount=JSON.parse(bytes);cutAccount.name='QACutUser';cutAccount.name_chosen=true;cutAccount.origin.namespace='d'.repeat(64);await writeFile(selected,JSON.stringify(cutAccount));
  const passwordC='phase4-independent-cut-C';const cutLogin=await begin();const beforeCutImport=await fingerprint(state);
  const cutAuthority=async(command,trigger)=>{
   const mainPid=await launcher.evaluate(()=>process.pid);await trigger();let authority;
   const deadline=Date.now()+10000;
   while(Date.now()<deadline&&!authority){const children=(await readFile(`/proc/${mainPid}/task/${mainPid}/children`,'utf8')).trim().split(/\s+/).filter(Boolean);for(const id of children){try{const args=(await readFile(`/proc/${id}/cmdline`,'utf8')).split('\0');if(args[1]==='--local-save'&&args[2]===command){process.kill(Number(id),'SIGSTOP');authority={pid:Number(id),args};break;}}catch(error){if(error.code!=='ENOENT'&&error.code!=='ESRCH')throw error;}}if(!authority)await delay(1);}
   assert(authority,'Owned authority child must be observed before an intentional cut');assert.equal(sha256(await readFile(`/proc/${authority.pid}/exe`)),build.binarySha256);
   let paused,primary;
   try{paused=await fingerprint(state);process.kill(mainPid,'SIGKILL');await wait(()=>!alive(mainPid),'intentional launcher cut',10000);launcher=undefined;}
   catch(error){primary=error;throw error;}
   finally{try{if(alive(authority.pid))process.kill(authority.pid,'SIGCONT');await wait(()=>!alive(authority.pid),'owned authority settles after cut',60000);}catch(cleanup){throw Error(`${primary?`Primary cut error: ${primary}. `:''}Authority cleanup: ${cleanup}`);}}
   (report.cuts??=[]).push({command,launcherPid:mainPid,authority,pausedFingerprint:paused,scope:'No exit0 or operation success is claimed from orphan observation; exact old/complete state is independently checked after reopening'});
  };
  await cutAuthority('import',async()=>{await page.locator('#password').fill(passwordC);await page.locator('#confirmation').fill(passwordC);await page.locator('#import-confirm').click();});
  const afterCutImport=await fingerprint(state),cutImportMetadata=await cli('verify-snapshot',[join(state,'game.db'),data]);assert([2,3].includes(cutImportMetadata.account_count));if(cutImportMetadata.account_count===2)assert.deepEqual(afterCutImport,beforeCutImport);
  report.cuts.at(-1).afterFingerprint=afterCutImport;report.cuts.at(-1).metadata=cutImportMetadata;await launch();await start();await auth(login,passwordA,passwordB,-1);if(cutImportMetadata.account_count===3)await auth(cutLogin,passwordC,passwordA,2711);else assert((await accounts(cutLogin,passwordC)).includes('<Error'));await stop();
  check('Packaged import interruption leaves verified old or complete state; original credentials/progress remain recoverable',true);
  if(cutImportMetadata.account_count===2){await begin();await commit(passwordC);}
  const beforeCutRestore=await fingerprint(state);await choice(older);await confirm(1);
  await cutAuthority('restore',async()=>{await page.locator('#restore').click();});
  const afterCutRestore=await fingerprint(state);
  const fullOlder=JSON.parse(await run('python3',[resolve('scripts/save-state.py'),older]));assert([beforeCutRestore.sha256,fullOlder.sha256].includes(afterCutRestore.sha256));report.cuts.at(-1).afterFingerprint=afterCutRestore;
  await launch();await start();await auth(login,passwordA,passwordB,-1);await stop();await launcher.close();launcher=undefined;await writeFile(selected,bytes);
  check('Packaged restore interruption reopens exact full old or restored snapshot with original credentials',true);
  // A read-only target permits the verified pre-backup, then fails after the authority's destination activation boundary.
  profile=join(out,'unknown-outcome-profile');await launch();await run(binary,['--backup-fixture',state,data]);await cli('restore',[state,data,older,join(out,'unknown-setup-pre-restore.sqlite')]);await begin();const unknownBefore=await fingerprint(state);await chmod(join(state,'game.db'),0o400);
  try{await page.locator('#password').fill(passwordB);await page.locator('#confirmation').fill(passwordB);await page.locator('#import-confirm').click();await wait(async()=>(await view()).status==='failed'&&/completion is unverified/.test(await page.locator('#error').innerText()),'actual post-boundary unknown barrier',60000);assert.deepEqual(await fingerprint(state),unknownBefore);const rejected=await page.evaluate(async()=>Promise.all([window.launcher.start(),window.launcher.importPlayer(),window.launcher.makeBackup()].map(p=>p.then(()=>false,()=>true))));assert(rejected.every(Boolean));}
  finally{await chmod(join(state,'game.db'),0o600);}
  await wait(async()=>!!await stat(join(user,'shutdown-failed.json')).catch(e=>{if(e.code==='ENOENT')return undefined;throw e;}),'durable unknown marker');report.unknownOutcome={view:await view(),before:unknownBefore,after:await fingerprint(state),marker:JSON.parse(await readFile(join(user,'shutdown-failed.json'),'utf8'))};assert.match(report.unknownOutcome.marker.error,/outcome unknown|unknown/i);await screenshot('05-unknown-replay-blocked');
  const unknownBackups=join(user,'backups');for(const name of await readdir(unknownBackups))await cli('verify-snapshot',[join(unknownBackups,name),data]);
  await launcher.evaluate(({dialog})=>{dialog.showErrorBox=()=>{};});const unknownPid=await launcher.evaluate(()=>process.pid);await launcher.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await wait(()=>!alive(unknownPid),'unknown launcher retains barrier and exits',10000);launcher=undefined;check('Actual Rust post-activation failure remains UNKNOWN despite unchanged rollback; durable replay barrier retained',true);
  // Failed shutdown is isolated from the accepted save; do not repair/remove a durable failure gate.
  profile=join(out,'failed-shutdown-profile');await launch();await run(binary,['--backup-fixture',state,data]);const failedServer=await start();process.kill(failedServer.pid,'SIGSTOP');const failedBefore=await fingerprint(state);
  try{await choice(selected);await page.locator('#import').click();await wait(async()=>(await view()).status==='failed','real 45 second durable-stop refusal',60000);assert.match(await page.locator('#error').innerText(),/NOT force-killed|Shutdown/);assert.deepEqual(await fingerprint(state),failedBefore);assert.equal((await launcher.evaluate(()=>globalThis.saveTest.events)).filter(x=>x.kind==='choose').length,0);check('Actual failed shutdown aborts import before chooser/authority; no force kill or save success',true);}
  finally{process.kill(failedServer.pid,'SIGCONT');await wait(()=>!alive(failedServer.pid),'resumed owned server drain',60000);}
  await launcher.evaluate(({dialog})=>{dialog.showErrorBox=()=>{};});const failedPid=await launcher.evaluate(()=>process.pid);await launcher.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await wait(()=>!alive(failedPid),'failed launcher closes with durable marker',10000);launcher=undefined;assert((await readFile(join(user,'shutdown-failed.json'),'utf8')).includes('Shutdown exceeded'));
  assert.deepEqual(await tree(resources,['data','client','notices','openrotmg','REVISION','inventory.json','build-identity.json']),installedBefore);assert.equal(sha256(await readFile(join(installation,'resources/app.asar'))),report.build.appAsarSha256);report.installedRuntimeInvariantSha256=installedBefore.sha256;check('All save, staging, backup and native operations leave the non-writable installed generation unchanged',true);
  report.backups=[];for(const name of (await readdir(backups)).sort()){const path=join(backups,name),info=await stat(path);report.backups.push({path,bytes:info.size,modifiedAt:info.mtime.toISOString(),sha256:sha256(await readFile(path)),metadata:await cli('verify-snapshot',[path,data])});}
  const secrets=[passwordA,passwordB,passwordC,passwordD,'backup-fixture-password'];let scannedBytes=0;
  const scan=async path=>{const info=await lstat(path);if(info.isDirectory())for(const name of await readdir(path))await scan(join(path,name));else if(info.isFile()){const bytes=await readFile(path);scannedBytes+=bytes.length;for(const secret of secrets)assert(!bytes.includes(Buffer.from(secret)),`Plaintext credential persisted at ${path}`);}};
  for(const directory of report.userDataDirectories)await scan(directory);report.privacyScannedBytes=scannedBytes;check('Launcher renderer storage is empty and every launcher profile/save/backup/log file is plaintext-password free',true);
  for(const secret of secrets)assert(!JSON.stringify(report).includes(secret),'No plaintext password in retained report');
  report.status='passed';
 }catch(error){report.status='failed';report.errors.push(String(error.stack??error));process.exitCode=1;console.error(report.errors.at(-1));if(page&&!page.isClosed())try{await screenshot('failure');}catch(cause){report.errors.push(String(cause));}}
 finally{
  if(folderManagerPid)try{if(alive(folderManagerPid))process.kill(folderManagerPid,'SIGTERM');await wait(()=>!alive(folderManagerPid),'owned folder-manager cleanup',10000);}catch(error){report.errors.push('file-manager cleanup: '+error);}
  if(game)try{await game.close();}catch(error){report.errors.push('browser cleanup: '+error);}
  if(launcher)try{await launcher.close();}catch(error){report.errors.push('launcher cleanup: '+error);}
  if(display){display.kill('SIGTERM');try{await wait(()=>display.exitCode!==null||display.signalCode!==null,'private Xvfb cleanup',10000);}catch(error){report.errors.push(String(error));}}
  if(lease)try{await lease.release();}catch(error){report.errors.push(String(error));}
  if(report.errors.length){report.status='failed';process.exitCode=1;}report.cleanupComplete=!launcher?.process()?.pid||!alive(launcher.process().pid);
  await persist();console.log(`${report.status}: ${join(out,'result.json')}`);
 }
}
function alive(pid){try{process.kill(pid,0);const text=execFileSync('ps',['-o','stat=','-p',String(pid)],{encoding:'utf8'});return !text.startsWith('Z');}catch(error){if(error.code==='ESRCH'||error.status===1)return false;throw error;}}
async function wait(predicate,label,timeout=10000){const deadline=Date.now()+timeout;do{if(await predicate())return;await delay(100);}while(Date.now()<deadline);throw Error('Timed out: '+label);}
async function newOutput(out,name){const path=join(out,name);await mkdir(path);return path;}
