import test, {before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdir, mkdtemp, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {listenOnLoopback,acquireQaPortLease} from '../scripts/qa-port.mjs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { Runtime, PORT } from '../dist/runtime.js';

await mkdir('.qa/unit', { recursive: true });
let lease;before(async()=>{lease=await acquireQaPortLease();});after(async()=>{if(lease)await lease.release();});
async function fixture() {
  const root = await mkdtemp(resolve('.qa/unit/runtime-'));
  const resources = join(root, 'resources'), user = join(root, 'user');
  await mkdir(resources); await mkdir(user);
  await writeFile(join(resources, 'inventory.json'), JSON.stringify({ files: [] }));
  return { root, resources, user, runtime: new Runtime(resources, user) };
}
test('runtime reports missing binary without claiming a running server', async () => {
  const { runtime } = await fixture();
  await assert.rejects(runtime.start(), /ENOENT/);
  assert.equal(runtime.view().status, 'stopped');
  assert.match(runtime.view().message, /Cannot start/);
});
test('runtime occupied port never stops another listener', async () => {
  const { resources, runtime } = await fixture();
  await writeFile(join(resources, process.platform === 'win32' ? 'openrotmg.exe' : 'openrotmg'), '', { mode: 0o700 });
  const listener = createServer(); await listenOnLoopback(listener,PORT);
  try { await assert.rejects(runtime.start(), /unavailable/); assert(listener.listening); assert.equal(runtime.view().status, 'stopped'); }
  finally { await new Promise(ok => listener.close(ok)); }
});
test('runtime refuses sticky shutdown failure before spawning', async () => {
  const { user, runtime } = await fixture();
  await writeFile(join(user, 'shutdown-failed.json'), '{}');
  await assert.rejects(runtime.start(), /Previous server shutdown/);
  assert.equal(runtime.view().pid, undefined);
});
test('runtime validates all inventory paths before spawning', async () => {
  const { resources, runtime } = await fixture();
  await writeFile(join(resources, process.platform === 'win32' ? 'openrotmg.exe' : 'openrotmg'), '', { mode: 0o700 });
  await writeFile(join(resources, 'inventory.json'), JSON.stringify({ files: ['../escape'] }));
  await assert.rejects(runtime.start(), /Invalid bundled asset path/);
  assert.equal(runtime.view().pid, undefined);
});

test('QA listener bind conflicts reject without interrupting the owner',async()=>{
  const owner=createServer();await listenOnLoopback(owner,0);
  try{await assert.rejects(listenOnLoopback(createServer(),owner.address().port),/QA loopback port .* unavailable/);assert(owner.listening);}
  finally{await new Promise(ok=>owner.close(ok));}
});
test('QA OS lease rejects a cooperating second journey without waiting',{skip:process.platform!=='linux'},async()=>{
  await assert.rejects(acquireQaPortLease(),/Exclusive desktop QA port lease unavailable/);
});
test('runtime failure gate waits for delayed marker IO, writes once, and blocks relaunch',async t=>{
  const {runtime,resources,user}=await fixture();
  const original=fs.writeFile;
  let unblock,entered;const pending=new Promise(ok=>unblock=ok),writing=new Promise(ok=>entered=ok);let writes=0;
  t.mock.method(fs,'writeFile',async(path,...args)=>{
    if(String(path).endsWith('shutdown-failed.json')){writes++;entered();await pending;}
    return original(path,...args);
  });
  runtime.fail(new Error('injected failed shutdown'));
  await writing;
  let released=false;const close=runtime.verifyFailureGate().then(()=>released=true);
  await delay(50);assert.equal(released,false);await assert.rejects(readFile(join(user,'shutdown-failed.json')),/ENOENT/);
  runtime.fail(new Error('subsequent shutdown error'));
  unblock();await close;assert.equal(writes,1);
  await assert.rejects(new Runtime(resources,user).start(),/Previous server shutdown/);
});
test('runtime marker write failure is explicit and prevents ownership release',async()=>{
  const {runtime,user}=await fixture();await mkdir(join(user,'shutdown-failed.json'));
  runtime.fail(new Error('injected failed shutdown'));
  await assert.rejects(runtime.verifyFailureGate(),/Could not persist shutdown failure.*NOT recorded/);
  assert.match(runtime.view().message,/NOT recorded/);
  runtime.fail(new Error('later close attempt'));
  await assert.rejects(runtime.verifyFailureGate(),/NOT recorded/);
  assert.match(runtime.view().message,/ownership must be retained/);
});
test('runtime healthy child stays ready and usable beyond 16 MiB of diagnostics',{skip:process.platform==='win32'},async()=>{
  const {runtime,resources,user}=await fixture();
  await writeFile(join(resources,'openrotmg'),String.raw`#!${process.execPath}
const http=require('node:http'),fs=require('node:fs');
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({process:process.pid,bots:0,bot_dialogue:{enabled:false}}));});
server.listen(${PORT},'127.0.0.1',()=>{
  fs.writeSync(1,JSON.stringify({fields:{message:'game frontdoor listening'}})+'\n');
  const line=JSON.stringify({fields:{message:'ordinary diagnostic growth',detail:'x'.repeat(4096)}})+'\n';
  fs.writeSync(1,line.repeat(4200));
});
const stop=()=>server.close(()=>process.exit(0));process.stdin.on('data',stop);process.stdin.on('end',stop);
`,{mode:0o700});
  try{
    await runtime.start();await delay(500);
    const log=join(runtime.diagnostics,(await readdir(runtime.diagnostics))[0]);
    assert((await stat(log)).size>16*1024*1024);
    assert.equal(runtime.view().status,'ready');assert(runtime.view().logs.length<=300);
    assert.equal((await (await fetch(runtime.origin+'/health')).json()).process,runtime.view().pid);
    await assert.rejects(readFile(join(user,'shutdown-failed.json')),/ENOENT/);
  }finally{await runtime.stop();}
});

const healthy=String.raw`#!${process.execPath}
const http=require('node:http'),fs=require('node:fs');let requested=false;
const server=http.createServer((req,res)=>res.end(JSON.stringify({process:process.pid,bots:0,bot_dialogue:{enabled:false}})));
const stop=()=>{requested=true;if(server.listening)server.close(()=>process.exit(0));};
process.stdin.on('data',stop);process.stdin.on('end',stop);
setTimeout(()=>server.listen(${PORT},'127.0.0.1',()=>{fs.writeSync(1,JSON.stringify({fields:{message:'game frontdoor listening'}})+'\n');if(requested)stop();}),100);
`;
async function startupFixture() {
  await mkdir('.qa/unit',{recursive:true});const root=await mkdtemp(resolve('.qa/unit/startup-'));
  const resources=join(root,'resources'),user=join(root,'user');await mkdir(resources);await mkdir(user);
  await writeFile(join(resources,'inventory.json'),'{"files":[]}');
  return {runtime:new Runtime(resources,user),binary:join(resources,'openrotmg'),user};
}
async function waitStartup(predicate){const deadline=Date.now()+5000;while(!predicate()){assert(Date.now()<deadline,'Fixture event deadline');await delay(5);}}

test('runtime startup settlement prevents a failed attempt draining an immediate replacement',{skip:process.platform==='win32'},async()=>{
  const {runtime,binary,user}=await startupFixture();
  try {
    await writeFile(binary,`#!${process.execPath}\nprocess.exit(7);\n`,{mode:0o700});
    let sawPid=false;runtime.on('change',view=>{if(view.pid)sawPid=true;});
    let settled=false;const failed=runtime.start();const outcome=failed.then(()=>{settled=true;return undefined;},error=>{settled=true;return error;});
    await waitStartup(()=>sawPid&&!runtime.view().pid);
    assert.equal(settled,false,'Exercise the child-close versus still-pending startup boundary');
    assert.notEqual(runtime.view().status,'stopped','Start must not appear admitted while failed bootstrap remains pending');
    await assert.rejects(runtime.start(),/settled prior startup\/shutdown/);
    assert.match(String(await outcome),/Server exited before listening: code=7/);
    assert.doesNotMatch(runtime.view().message,/600 second/);
    await writeFile(binary,healthy,{mode:0o700});
    await runtime.start();const pid=runtime.view().pid;
    await delay(750);
    assert.equal(runtime.view().status,'ready');assert.equal(runtime.view().pid,pid);
    assert.equal((await (await fetch(runtime.origin+'/health')).json()).process,pid);
    await assert.rejects(readFile(join(user,'shutdown-failed.json')),/ENOENT/);
    await runtime.stop();assert.equal(runtime.view().status,'stopped');assert.equal(runtime.view().pid,undefined);
  }finally{if(runtime.view().pid)await runtime.stop();}
});

test('runtime Stop and Close await startup settlement before a new Start can be admitted',{skip:process.platform==='win32'},async()=>{
  const {runtime,binary}=await startupFixture();
  try{
    await writeFile(binary,healthy,{mode:0o700});
    const boot=runtime.start(),stop=runtime.stop();
    await assert.rejects(runtime.start(),/settled prior startup\/shutdown/);
    await Promise.all([boot,stop]);await runtime.verifyFailureGate();
    assert.equal(runtime.view().status,'stopped');assert.equal(runtime.view().pid,undefined);
    await runtime.start();const pid=runtime.view().pid;await delay(750);
    assert.equal(runtime.view().status,'ready');assert.equal(runtime.view().pid,pid);
    await runtime.stop();
  }finally{if(runtime.view().pid)await runtime.stop();}
});

test('runtime exit7 while bootstrap is pending cannot become verified exit0 through Stop or Close',async t=>{
  if(process.platform==='win32'){t.skip('Supplementary shebang child requires POSIX');return;}
  const {runtime,binary,user}=await startupFixture();
  await writeFile(binary,`#!${process.execPath}\nprocess.exit(7);\n`,{mode:0o700});
  const original=fs.writeFile;let unblock,entered;
  const pending=new Promise(ok=>unblock=ok),writing=new Promise(ok=>entered=ok);
  t.mock.method(fs,'writeFile',async(path,...args)=>{if(String(path).endsWith('shutdown-failed.json')){entered();await pending;}return original(path,...args);});
  let sawPid=false;runtime.on('change',view=>{if(view.pid)sawPid=true;});
  const boot=runtime.start().then(()=>undefined,error=>error);
  try{
    await waitStartup(()=>sawPid&&!runtime.view().pid);
    const stopped=runtime.stop().then(()=>undefined,error=>error);
    assert.match(String(await boot),/Server exited before listening: code=7/);
    assert.match(String(await stopped),/Server exited before listening: code=7/);
    assert.equal(runtime.view().status,'failed');assert.doesNotMatch(runtime.view().message,/Durable shutdown verified/);
    await writing;let mayExit=false;
    const closeGate=runtime.verifyFailureGate().then(()=>mayExit=true);
    await delay(50);assert.equal(mayExit,false,'Close must retain ownership until the failure is recorded');
    await assert.rejects(runtime.start(),/verified stopped server/);
    unblock();await closeGate;
    assert.match(JSON.parse(await readFile(join(user,'shutdown-failed.json'),'utf8')).error,/code=7/);
    await assert.rejects(new Runtime(runtime.resources,user).start(),/Previous server shutdown/);
  }finally{unblock();if(runtime.view().pid)await runtime.stop();}
});
