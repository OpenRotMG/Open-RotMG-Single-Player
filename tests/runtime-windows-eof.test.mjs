import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {desktopServerSpawnOptions} from '../dist/runtime.js';

test('runtime Windows job isolation retains private stdin, direct log descriptors, hidden window and referenced ownership',()=>{
  const env={SystemRoot:'owned-system'},expected={cwd:'owned-resources',env,windowsHide:true,stdio:['pipe',42,42]};
  assert.deepEqual(desktopServerSpawnOptions('win32','owned-resources',env,42),{...expected,detached:true});
  for(const platform of ['linux','darwin'])assert.deepEqual(desktopServerSpawnOptions(platform,'owned-resources',env,42),{...expected,detached:false});
});

async function fixtureFiles(){
  await mkdir('.qa/unit',{recursive:true});const root=await mkdtemp(resolve('.qa/unit/windows-eof-')),childFile=join(root,'child.mjs'),parentFile=join(root,'parent.mjs');
  await writeFile(childFile,`
import fs from 'node:fs';
import {join} from 'node:path';
const root=process.argv[2];let input='';
const publish=(name,value)=>{fs.writeFileSync(join(root,name+'.tmp'),JSON.stringify(value));fs.renameSync(join(root,name+'.tmp'),join(root,name));};
const watchdog=setTimeout(()=>{fs.writeFileSync(join(root,'watchdog.json'),'{}');process.exit(91);},20000);
process.stdin.on('data',bytes=>input+=bytes);
process.stdin.on('end',()=>{
  const reason=input==='stop\\n'?'stop':input===''?'parent_eof':'invalid';
  fs.writeSync(1,JSON.stringify({message:'drain started',reason})+'\\n');
  setTimeout(()=>{
    fs.writeSync(1,JSON.stringify({message:'delayed drain complete',reason})+'\\n');fs.fsyncSync(1);
    publish('complete.json',{pid:process.pid,reason});clearTimeout(watchdog);process.exit(reason==='invalid'?1:0);
  },250);
});
process.stdin.resume();publish('ready.json',{pid:process.pid});
`);
  await writeFile(parentFile,`
import {spawn} from 'node:child_process';
import {open,writeFile} from 'node:fs/promises';
import {writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {desktopServerSpawnOptions} from ${JSON.stringify(pathToFileURL(resolve('dist/runtime.js')).href)};
const root=process.argv[2],log=await open(join(root,'diagnostics.jsonl'),'wx+');
const child=spawn(process.execPath,[join(root,'child.mjs'),root],desktopServerSpawnOptions(process.platform,root,process.env,log.fd));
child.once('error',error=>{throw error;});
child.once('close',async(code,signal)=>{await log.sync();await log.close();await writeFile(join(root,'parent-result.json'),JSON.stringify({code,signal}));process.exit(code===0?0:1);});
let forwarded='',acknowledged=false;
const acknowledge=()=>{writeFileSync(join(root,'forwarded.tmp'),JSON.stringify({text:forwarded}));renameSync(join(root,'forwarded.tmp'),join(root,'forwarded.json'));acknowledged=true;};
process.stdin.on('data',bytes=>{
  child.stdin.write(bytes);forwarded+=bytes.toString();
  if(!acknowledged&&forwarded.length>=2)acknowledge();
});
process.stdin.on('end',()=>{if(!acknowledged)acknowledge();child.stdin.end();});process.stdin.resume();
`);
  return root;
}
test('runtime Windows EOF fixture scripts parse before native execution',async()=>{
  const root=await fixtureFiles();for(const file of ['parent.mjs','child.mjs'])execFileSync(process.execPath,['--check',join(root,file)]);
});
for(const mode of ['stop','parent_eof'])test(`runtime Windows ${mode} completes delayed private drain with inherited file diagnostics`,{skip:process.platform!=='win32',timeout:40000},async t=>{
  const root=await fixtureFiles(),parentFile=join(root,'parent.mjs');
  const parent=spawn(process.execPath,[parentFile,root],{windowsHide:true,stdio:['pipe','ignore','ignore']});
  const closed=new Promise((ok,bad)=>{parent.once('error',bad);parent.once('close',(code,signal)=>ok({code,signal}));});let childPid;
  t.after(async()=>{
    if(parent.exitCode===null&&parent.signalCode===null)parent.kill('SIGKILL');await closed;
    if(childPid)await wait(async()=>!alive(childPid),'owned fixture exits or self-watchdog fails',25000);
  });
  const ready=await wait(()=>jsonIfPresent(join(root,'ready.json')),'owned child readiness');childPid=ready.pid;
  if(mode==='stop'){
    parent.stdin.write('st');assert.deepEqual(await wait(()=>jsonIfPresent(join(root,'forwarded.json')),'first fragment forwarded'),{text:'st'});
    parent.stdin.end('op\n');assert.equal((await closed).code,0);assert.deepEqual(await jsonIfPresent(join(root,'parent-result.json')),{code:0,signal:null});
  }else{assert(parent.kill('SIGKILL'));await closed;}
  const complete=await wait(()=>jsonIfPresent(join(root,'complete.json')),'delayed EOF drain completion');assert.equal(complete.pid,childPid);assert.equal(complete.reason,mode);
  await wait(async()=>!alive(childPid),'actual child exit');
  const log=await readFile(join(root,'diagnostics.jsonl'),'utf8');assert.match(log,/drain started/);assert.match(log,/delayed drain complete/);assert.equal(await jsonIfPresent(join(root,'watchdog.json')),undefined);
});
async function jsonIfPresent(path){try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return undefined;throw error;}}
async function wait(predicate,label,timeout=10000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await predicate();if(value)return value;await delay(20);}throw Error(`Fixture deadline: ${label}`);}
function alive(pid){try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}
