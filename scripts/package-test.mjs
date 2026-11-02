import { _electron as electron } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, chmod, readdir, rename, rm, cp } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { nativeGame } from './native-game.mjs';
import { sha256 } from './assets.mjs';
import { processArgv } from './process-argv.mjs';
import { release, type } from 'node:os';
import {listenOnLoopback,acquireQaPortLease} from './qa-port.mjs';
import {failureCloseTests} from './failure-close-test.mjs';
import {PORT} from '../dist/runtime.js';
import {consumerEnvironment,protectInstallation,assertInstallationProtected,suspendServer,runtimeLinkage,windowsPowerShellExecutable} from './native-boundaries.mjs';
import {rejectStateContender,crashReleasedRestart} from './state-ownership-test.mjs';
import {packagedChildReady} from './package-readiness.mjs';

if (process.platform === 'linux' && !process.env.OPENROTMG_PRIVATE_TEST) {
  const child = spawn('dbus-run-session', [process.execPath, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, OPENROTMG_PRIVATE_TEST: '1' } });
  child.on('exit', code => process.exitCode = code ?? 1);
} else {
  await mkdir('.qa/package-tests', { recursive: true });
  const out = await mkdtemp(resolve('.qa/package-tests/run-'));
  const report = { status: 'running', out, host: {type:type(),release:release()}, os: process.platform, arch: process.arch, versions: process.versions, assertions: [], screenshots: [], errors: [] };
  const check = (name, value) => { assert(value, name); report.assertions.push(name); console.log(`PASS ${name}`); };
  let display, launcher, launcherPid, browserCleanup, serverPid, lease, restoreInstallation;
  const env = { ...process.env, XDG_CONFIG_HOME: join(out, 'config'), XDG_CACHE_HOME: join(out, 'cache') };
  delete env.WAYLAND_DISPLAY;
  try {
    const tmpRoot=process.env.OPENROTMG_TEST_TMP_ROOT;
    assert(!tmpRoot||isAbsolute(tmpRoot),'OPENROTMG_TEST_TMP_ROOT must be an absolute owned on-disk directory');
    if(tmpRoot)await mkdir(tmpRoot,{recursive:true});
    const tmp=await mkdtemp(tmpRoot?join(tmpRoot,'t-'):process.env.GITHUB_ACTIONS==='true'?join(process.env.RUNNER_TEMP,'openrotmg-'):resolve('.qa/t-'));
    report.tmp=tmp;
    assert(process.platform!=='linux'||Buffer.byteLength(tmp)<65,'Private on-disk TMPDIR must fit Chromium Unix socket paths; set OPENROTMG_TEST_TMP_ROOT to a shorter owned path');
    Object.assign(process.env,{TMPDIR:tmp,TEMP:tmp,TMP:tmp});Object.assign(env,{TMPDIR:tmp,TEMP:tmp,TMP:tmp});
    report.launcherSource={head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim()!==''};
    lease=await acquireQaPortLease();report.qaOwnership=lease.kind;
    const probe=createServer();await listenOnLoopback(probe,PORT);await new Promise(ok=>probe.close(ok));
    if(!process.argv.includes('--check-port-only')) {
    if (process.platform === 'linux') {
      const auth = join(out, 'Xauthority'), cookie = randomBytes(16).toString('hex');
      await writeFile(auth, '', { mode: 0o600 });
      execFileSync('xauth', ['-f', auth, 'add', ':99', 'MIT-MAGIC-COOKIE-1', cookie]);
      display = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1400x1000x24', '-nolisten', 'tcp', '-auth', auth], { stdio: ['ignore','ignore','pipe','pipe'] });
      let number = ''; display.stdio[3].on('data', bytes => number += bytes);
      await wait(() => number.includes('\n'), 'private Xvfb display', 10000);
      env.DISPLAY = ':' + number.trim(); env.XAUTHORITY = auth;
      execFileSync('xauth', ['-f', auth, 'add', env.DISPLAY, 'MIT-MAGIC-COOKIE-1', cookie]);
    }
    const packageDir = join(out,'installed runtime with spaces');
    await cp(resolve(`out/Open RotMG Single Player-${process.platform}-${process.arch}`),packageDir,{recursive:true,verbatimSymlinks:true});
    const native = process.platform === 'darwin' ? join(packageDir, 'Open RotMG Single Player.app/Contents/MacOS/openrotmg-single-player') : join(packageDir, process.platform === 'win32' ? 'openrotmg-single-player.exe' : 'openrotmg-single-player');
    report.executable = native; report.sha256 = sha256(await readFile(native));
    report.appAsarSha256=sha256(await readFile(process.platform==='darwin'?join(packageDir,'Open RotMG Single Player.app/Contents/Resources/app.asar'):join(packageDir,'resources/app.asar')));
    report.build = JSON.parse(await readFile(process.platform === 'darwin' ? join(packageDir,'Open RotMG Single Player.app/Contents/Resources/runtime/build-identity.json') : join(packageDir,'resources/runtime/build-identity.json')));
    const consumerEnv=await consumerEnvironment(env,out);
    report.consumerPath=consumerEnv.PATH;
    let profile = join(out,'launcher-profile');
    const launch = async () => {
      launcher = await electron.launch({ executablePath: native, args: [`--user-data-dir=${profile}`,...(process.platform==='linux'?['--ozone-platform=x11']:[])], chromiumSandbox: true, env:consumerEnv, timeout: 30000 });
      const page = await launcher.firstWindow(); await page.waitForFunction(() => !!window.launcher);
      launcherPid=await launcher.evaluate(()=>process.pid);
      const argvText = await processArgv(launcherPid);
      (report.launches??=[]).push({pid:launcherPid,controllerPid:launcher.process().pid,argv:argvText,versions:await launcher.evaluate(()=>process.versions)});
      check('actual packaged Electron argv has no --no-sandbox', !argvText.includes('--no-sandbox'));
      check('packaged launcher has no developer-tool PATH or injected Node options',await launcher.evaluate(()=>process.env.PATH)===consumerEnv.PATH&&!(await launcher.evaluate(()=>process.env.NODE_OPTIONS)));
      const preferences = await launcher.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
      check('renderer contextIsolation and sandbox are enabled', preferences.contextIsolation && preferences.sandbox && !preferences.nodeIntegration);
      return page;
    };
    if(!process.argv.includes('--failure-tests-only')) {
    let page = await launch();
    const userData = await launcher.evaluate(({app}) => app.getPath('userData'));
    check('test userData is owned outside install', userData.startsWith(out) && !userData.startsWith(packageDir));
    report.userData = userData;
    const resources = await launcher.evaluate(() => process.resourcesPath);
    const binary = join(resources, 'runtime', process.platform === 'win32' ? 'openrotmg.exe' : 'openrotmg');
    if(process.platform==='win32')report.qaPowerShell=windowsPowerShellExecutable();
    report.serverLinkage=runtimeLinkage(binary);
    const occupied = createServer(); await listenOnLoopback(occupied,PORT);
    try {
      await page.getByRole('button',{name:'Start Server',exact:true}).click();
      await wait(async () => (await page.evaluate(() => window.launcher.status())).message.includes('unavailable'), 'occupied port error',10000);
      check('packaged occupied-port error never signals another process', occupied.listening && (await page.evaluate(() => window.launcher.status())).status==='stopped');
    } finally {await new Promise(ok=>occupied.close(ok));}
    const asset = join(resources,'runtime/client/index.html');
    await rename(asset,asset+'.missing');
    try {
      await page.getByRole('button',{name:'Start Server',exact:true}).click();
      await wait(async () => (await page.evaluate(() => window.launcher.status())).message.includes('ENOENT'), 'missing-asset error',10000);
      check('packaged missing asset is reported before child spawn', !(await page.evaluate(() => window.launcher.status())).pid);
    } finally {await rename(asset+'.missing',asset);}
    await writeFile(join(userData,'state'),'not a save directory');
    try {
      await page.getByRole('button',{name:'Start Server',exact:true}).click();
      await wait(async()=>{const view=await page.evaluate(()=>window.launcher.status());return view.status==='stopped'&&view.message.includes('before listening');},'invalid-state error',30000);
      const view=await page.evaluate(()=>window.launcher.status());report.invalidState=view;
      report.invalidStateSentinel=await readFile(join(userData,'state'),'utf8');
      check('packaged invalid state exits1 without changing the sentinel and reports the actual IO error',view.message.includes('code=1')&&!view.pid&&report.invalidStateSentinel==='not a save directory'&&view.logs.some(line=>/^Error: .+\(os error \d+\)/.test(line)));
    } finally {await rm(join(userData,'state'));}
    restoreInstallation=await protectInstallation(packageDir);
    await assertInstallationProtected(packageDir,join(resources,'runtime'));
    await launcher.close();launcher=undefined;page=await launch();
    check('native package launches from OS-enforced non-writable installation with spaces',packageDir.includes(' '));
    if(process.platform!=='win32') {
      await mkdir(join(userData,'state'),{mode:0o000});
      try {
        await page.getByRole('button',{name:'Start Server',exact:true}).click();
        await wait(async()=>{const view=await page.evaluate(()=>window.launcher.status());return view.status==='stopped'&&view.message.includes('before listening');},'unreadable-state error',30000);
        check('packaged unreadable state is explicit and does not start', (await page.evaluate(()=>window.launcher.status())).logs.some(line=>/Permission denied/.test(line)));
      } finally {await chmod(join(userData,'state'),0o700);await rm(join(userData,'state'),{recursive:true});}
    }
    execFileSync(binary, ['--backup-fixture', join(userData, 'state'), join(resources, 'runtime/data')], { timeout: 30000 });
    execFileSync(binary, ['--backup-load', join(userData, 'state/game.db'), join(resources, 'runtime/data')], { timeout: 30000 });
    check('server-authoritative fresh synthetic fixture validated before consumer start', true);
    const start = async () => {
      await page.getByRole('button', {name:'Start Server',exact:true}).click();
      await wait(async () => packagedChildReady(await page.evaluate(() => window.launcher.status())), 'packaged child readiness', 650000);
      const view = await page.evaluate(() => window.launcher.status()); serverPid = view.pid;
      const health = await (await fetch(view.origin+'/health')).json();
      check('health belongs to packaged spawned child', health.process === serverPid);
      check('consumer bots/LLM disabled', health.bots === 0 && !health.bot_dialogue.enabled);
      const childArgv=await processArgv(serverPid);
      check('compiled child has explicit desktop/config and no consumer test privilege',childArgv.includes('--desktop')&&childArgv.includes('--config')&&!/--dev-control|--test-state/.test(childArgv));
      (report.servers??=[]).push({pid:serverPid,argv:childArgv,health});
      const files=await readdir(join(await launcher.evaluate(({app})=>app.getPath('userData')),'state'));
      check('consumer state has no dev-control token or prepared test marker',!files.includes('control.token')&&!files.includes('testing.json'));
      return view;
    };
    const stop = async () => {
      await page.getByRole('button', {name:'Stop Server',exact:true}).click();
      await wait(async () => (await page.evaluate(() => window.launcher.status())).status === 'stopped', 'verified consumer drain', 650000);
      check('spawned server is gone after stop', !alive(serverPid));
    };
    const closeActive=async kind=>{
      const child=launcher.process(),pid=serverPid,mainPid=launcherPid;
      await launcher.evaluate(({BrowserWindow,app},kind)=>{if(kind==='window-close')BrowserWindow.getAllWindows()[0].close();else app.quit();},kind);
      await wait(()=>!alive(mainPid)&&child.exitCode!==null,'active-character Close/Quit drains and exits',650000);launcher=undefined;
      check(`${kind}: packaged Close/Quit exits0 after active-character durable drain`,child.exitCode===0&&!alive(pid));
      const names=(await readdir(join(userData,'diagnostics'))).sort();
      check(`${kind}: actual child records completed shutdown persistence`,(await readFile(join(userData,'diagnostics',names.at(-1)),'utf8')).includes('shutdown persistence complete'));
    };
    const view = await start();
    await rejectStateContender({binary,userData,out,env:consumerEnv,check,report});
    const second=spawn(native,[`--user-data-dir=${profile}`,...(process.platform==='linux'?['--ozone-platform=x11']:[])],{env,stdio:'ignore'});
    await wait(()=>second.exitCode!==null||second.signalCode!==null,'second launcher refuses same userData owner',10000);
    check('single-instance lock rejects a second packaged launcher without stopping child',second.exitCode===0&&alive(serverPid));
    const shot = join(out, 'launcher-ready.png'); await page.screenshot({path:shot}); report.screenshots.push(shot);
    const game = await nativeGame({ out, origin:view.origin, env, check, report });
    browserCleanup = game.close;
    await game.mutate();
    await stop();
    await game.close();browserCleanup=undefined;
    await start();await game.verify(true);browserCleanup=game.close;
    await closeActive('window-close');
    await game.close(); browserCleanup = undefined;
    page = await launch();
    await start();
    await game.verify(true);browserCleanup=game.close;
    await closeActive('application-quit');
    await game.close();browserCleanup=undefined;
    page = await launch(); await start();
    await game.verify(true); browserCleanup = game.close;
    const crashedPid = serverPid, crashedLauncherPid = launcherPid;
    process.kill(crashedLauncherPid,'SIGKILL');
    await wait(() => !alive(crashedLauncherPid), 'launcher crash', 10000); launcher = undefined;
    await wait(() => !alive(crashedPid), 'server drains private stdin EOF after launcher crash', 650000);
    check('launcher crash leaves no orphan child', true);
    const diagnostics = join(userData, 'diagnostics');
    const logNames = (await readdir(diagnostics)).sort();
    const crashLog = await readFile(join(diagnostics,logNames.at(-1)), 'utf8');
    check('abrupt parent EOF requests durable drain while native character connected', crashLog.includes('parent_eof') && crashLog.includes('shutdown persistence complete'));
    await game.close(); browserCleanup = undefined;
    page = await launch(); await start(); await game.verify(true);browserCleanup=game.close;
    process.kill(serverPid,'SIGKILL');
    await wait(async()=>{const view=await page.evaluate(()=>window.launcher.status());return view.status==='failed'&&!view.pid;},'actual server crash releases process',10000);
    check('actual server crash gates consumer restart without a false save-success claim',await page.getByRole('button',{name:'Start Server',exact:true}).isDisabled());
    const crashShot=join(out,'server-crash-gated.png');await page.screenshot({path:crashShot});report.screenshots.push(crashShot);
    await game.close();browserCleanup=undefined;
    await crashReleasedRestart({binary,userData,out,env:consumerEnv,origin:view.origin,game,check,report});
    await launcher.evaluate(({dialog})=>{dialog.showErrorBox=()=>{};});
    const failedPid=launcherPid;await launcher.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
    await wait(()=>!alive(failedPid),'failed launcher closes after durable gate',10000);launcher=undefined;
    check('server crash failure marker remains intact after independent OS-lock proof',JSON.parse(await readFile(join(userData,'shutdown-failed.json'),'utf8')).error.includes('without verified shutdown'));
    profile=join(out,'initialization-profile');page=await launch();
    await page.getByRole('button',{name:'Start Server',exact:true}).click();
    await page.getByRole('button',{name:'Stop Server',exact:true}).click();
    await wait(async()=>(await page.evaluate(()=>window.launcher.status())).status==='stopped','close during synchronous initialization drains after boot',650000);
    check('stop during initialization waits for verified shutdown',true);
    await launcher.close(); launcher = undefined;
    {
      profile=join(out,'timeout-profile');page=await launch();await start();
      suspendServer(serverPid,true);
      try {
        await page.getByRole('button',{name:'Stop Server',exact:true}).click();
        await wait(async()=>(await page.evaluate(()=>window.launcher.status())).status==='failed','real shutdown timeout',60000);
        const failed=await page.evaluate(()=>window.launcher.status());
        check('shutdown timeout blocks save mutations and never claims forced-stop success',failed.message.includes('NOT force-killed')&&await page.getByRole('button',{name:'Start Server',exact:true}).isDisabled());
      } finally {suspendServer(serverPid,false);}
      await wait(()=>!alive(serverPid),'owned suspended child resumes and drains',60000);
      const failedData=await launcher.evaluate(({app})=>app.getPath('userData'));
      check('failed shutdown leaves durable diagnostic gate',JSON.parse(await readFile(join(failedData,'shutdown-failed.json'),'utf8')).error.length>0);
      process.kill(launcherPid,'SIGKILL');await wait(()=>!alive(launcherPid),'failed launcher test teardown',10000);launcher=undefined;
    }
    }
    await failureCloseTests({out,native,env,check,report});
    }
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.errors.push(String(error.stack ?? error)); process.exitCode = 1;
    report.cleanupPending=true;console.error(report.errors.at(-1));
    await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));
    const page=launcher?.windows()[0];
    if(page&&!page.isClosed())try{
      report.failureView=await page.evaluate(()=>window.launcher.status());
      const path=join(out,'integration-failure.png');await page.screenshot({path});report.screenshots.push(path);
    }catch(cause){report.failureEvidenceError=String(cause);}
    await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));
  }
  finally {
    if (browserCleanup) try { await browserCleanup(); } catch(error) { report.errors.push(`browser cleanup: ${error}`); process.exitCode = 1; }
    if (launcher) try { await launcher.close(); } catch(error) { report.errors.push(`launcher cleanup: ${error}`); process.exitCode = 1; }
    if (serverPid && alive(serverPid)) { report.errors.push(`Server PID ${serverPid} still alive; NOT force-killed; save success not claimed`); process.exitCode = 1; }
    if(display){
      display.kill('SIGTERM');
      try{await wait(()=>display.exitCode!==null||display.signalCode!==null,'private Xvfb cleanup',5000);}catch(error){report.errors.push(String(error));process.exitCode=1;}
    }
    if(restoreInstallation)try{await restoreInstallation();}catch(error){report.errors.push(`Install ACL cleanup: ${error}`);process.exitCode=1;}
    if(lease)try{await lease.release();}catch(error){report.errors.push(String(error));process.exitCode=1;}
    if(report.errors.length)report.status='failed';
    report.cleanupPending=false;
    await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));
    console.log(`${report.status}: ${join(out,'result.json')}`);
    if (report.errors.length) console.error(report.errors.join('\n'));
  }
}
function alive(pid) { try { process.kill(pid,0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
async function wait(predicate, message, timeout) {
  const deadline = Date.now()+timeout;
  do { if (await predicate()) return; await delay(200); } while (Date.now()<deadline);
  throw Error(`Timed out waiting for ${message}`);
}
