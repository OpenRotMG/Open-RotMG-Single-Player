import { _electron as electron } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, chmod, readdir, rename, stat, lstat, rm, cp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
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

if (process.platform === 'linux' && !process.env.OPENROTMG_PRIVATE_TEST) {
  const child = spawn('dbus-run-session', [process.execPath, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, OPENROTMG_PRIVATE_TEST: '1' } });
  child.on('exit', code => process.exitCode = code ?? 1);
} else {
  await mkdir('.qa/package-tests', { recursive: true });
  const out = await mkdtemp(resolve('.qa/package-tests/run-'));
  const report = { status: 'running', out, host: {type:type(),release:release()}, os: process.platform, arch: process.arch, versions: process.versions, assertions: [], screenshots: [], errors: [] };
  const check = (name, value) => { assert(value, name); report.assertions.push(name); console.log(`PASS ${name}`); };
  let display, launcher, browserCleanup, serverPid, lease;
  const tmp=await mkdtemp(process.env.GITHUB_ACTIONS==='true'?join(process.env.RUNNER_TEMP,'openrotmg-'):resolve('.qa/t-'));
  assert(process.platform!=='linux'||Buffer.byteLength(tmp)<65,'Private on-disk TMPDIR must fit Chromium Unix socket paths');
  report.tmp=tmp;process.env.TMPDIR=tmp;process.env.TEMP=tmp;process.env.TMP=tmp;
  const env = { ...process.env, XDG_CONFIG_HOME: join(out, 'config'), XDG_CACHE_HOME: join(out, 'cache') };
  delete env.WAYLAND_DISPLAY;
  try {
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
    let profile = join(out,'launcher-profile');
    const launch = async () => {
      launcher = await electron.launch({ executablePath: native, args: [`--user-data-dir=${profile}`,...(process.platform==='linux'?['--ozone-platform=x11']:[])], chromiumSandbox: true, env, timeout: 30000 });
      const page = await launcher.firstWindow(); await page.waitForFunction(() => !!window.launcher);
      const argvText = await processArgv(launcher.process().pid);
      (report.launches??=[]).push({pid:launcher.process().pid,argv:argvText,versions:await launcher.evaluate(()=>process.versions)});
      check('actual packaged Electron argv has no --no-sandbox', !argvText.includes('--no-sandbox'));
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
      const view=await page.evaluate(()=>window.launcher.status());
      check('packaged invalid state reports nonzero startup exit and readable diagnostics',view.message.includes('code=1')&&view.logs.some(line=>/File exists|Not a directory/.test(line)));
    } finally {await rm(join(userData,'state'));}
    if (process.platform !== 'win32') {
      await readOnly(packageDir);
      check('native package runs from non-writable installation with spaces',packageDir.includes(' ')&&((await stat(packageDir)).mode&0o222)===0);
    }
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
      await wait(async () => (await page.evaluate(() => window.launcher.status())).status === 'ready', 'packaged child readiness', 650000);
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
    const view = await start();
    const second=spawn(native,[`--user-data-dir=${profile}`,...(process.platform==='linux'?['--ozone-platform=x11']:[])],{env,stdio:'ignore'});
    await wait(()=>second.exitCode!==null||second.signalCode!==null,'second launcher refuses same userData owner',10000);
    check('single-instance lock rejects a second packaged launcher without stopping child',second.exitCode===0&&alive(serverPid));
    const shot = join(out, 'launcher-ready.png'); await page.screenshot({path:shot}); report.screenshots.push(shot);
    const game = await nativeGame({ out, origin:view.origin, env, check, report });
    browserCleanup = game.close;
    await game.mutate();
    await stop();
    await game.close(); browserCleanup = undefined;
    await launcher.close(); launcher = undefined;
    page = await launch();
    await start();
    await game.verify();
    await stop();
    await launcher.close(); launcher = undefined;
    page = await launch(); await start();
    await game.verify(true); browserCleanup = game.close;
    const crashedPid = serverPid, crashedLauncher = launcher.process();
    crashedLauncher.kill('SIGKILL');
    await wait(() => !alive(crashedLauncher.pid), 'launcher crash', 10000); launcher = undefined;
    await wait(() => !alive(crashedPid), 'server drains private stdin EOF after launcher crash', 650000);
    check('launcher crash leaves no orphan child', true);
    const diagnostics = join(userData, 'diagnostics');
    const logNames = (await readdir(diagnostics)).sort();
    const crashLog = await readFile(join(diagnostics,logNames.at(-1)), 'utf8');
    check('abrupt parent EOF requests durable drain while native character connected', crashLog.includes('parent_eof') && crashLog.includes('shutdown persistence complete'));
    await game.close(); browserCleanup = undefined;
    page = await launch(); await start(); await game.verify(); await stop();
    await page.getByRole('button',{name:'Start Server',exact:true}).click();
    await page.getByRole('button',{name:'Stop Server',exact:true}).click();
    await wait(async()=>(await page.evaluate(()=>window.launcher.status())).status==='stopped','close during synchronous initialization drains after boot',650000);
    check('stop during initialization waits for verified shutdown',true);
    await launcher.close(); launcher = undefined;
    if(process.platform!=='win32') {
      profile=join(out,'timeout-profile');page=await launch();await start();
      process.kill(serverPid,'SIGSTOP');
      try {
        await page.getByRole('button',{name:'Stop Server',exact:true}).click();
        await wait(async()=>(await page.evaluate(()=>window.launcher.status())).status==='failed','real shutdown timeout',60000);
        const failed=await page.evaluate(()=>window.launcher.status());
        check('shutdown timeout blocks save mutations and never claims forced-stop success',failed.message.includes('NOT force-killed')&&await page.getByRole('button',{name:'Start Server',exact:true}).isDisabled());
      } finally {process.kill(serverPid,'SIGCONT');}
      await wait(()=>!alive(serverPid),'owned suspended child resumes and drains',60000);
      const failedData=await launcher.evaluate(({app})=>app.getPath('userData'));
      check('failed shutdown leaves durable diagnostic gate',JSON.parse(await readFile(join(failedData,'shutdown-failed.json'),'utf8')).error.length>0);
      const failedLauncher=launcher.process();failedLauncher.kill('SIGKILL');await wait(()=>!alive(failedLauncher.pid),'failed launcher test teardown',10000);launcher=undefined;
    }
    }
    await failureCloseTests({out,native,env,check,report});
    }
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.errors.push(String(error.stack ?? error)); process.exitCode = 1; }
  finally {
    if (browserCleanup) try { await browserCleanup(); } catch(error) { report.errors.push(`browser cleanup: ${error}`); process.exitCode = 1; }
    if (launcher) try { await launcher.close(); } catch(error) { report.errors.push(`launcher cleanup: ${error}`); process.exitCode = 1; }
    if (serverPid && alive(serverPid)) { report.errors.push(`Server PID ${serverPid} still alive; NOT force-killed; save success not claimed`); process.exitCode = 1; }
    if(display){
      display.kill('SIGTERM');
      try{await wait(()=>display.exitCode!==null||display.signalCode!==null,'private Xvfb cleanup',5000);}catch(error){report.errors.push(String(error));process.exitCode=1;}
    }
    if(lease)try{await lease.release();}catch(error){report.errors.push(String(error));process.exitCode=1;}
    if(report.errors.length)report.status='failed';
    await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));
    console.log(`${report.status}: ${join(out,'result.json')}`);
    if (report.errors.length) console.error(report.errors.join('\n'));
  }
}
async function readOnly(path) {
  const info=await lstat(path);
  if(info.isSymbolicLink())return;
  if(info.isDirectory())for(const name of await readdir(path))await readOnly(join(path,name));
  await chmod(path,info.mode&~0o222);
}
function alive(pid) { try { process.kill(pid,0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
async function wait(predicate, message, timeout) {
  const deadline = Date.now()+timeout;
  do { if (await predicate()) return; await delay(200); } while (Date.now()<deadline);
  throw Error(`Timed out waiting for ${message}`);
}
