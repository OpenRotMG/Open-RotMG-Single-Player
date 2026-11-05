import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,readlink,writeFile} from 'node:fs/promises';
import {connect} from 'node:net';
import {resolve,dirname} from 'node:path';
const runtimeUpdates=process.argv.includes('--runtime-updates');
if(runtimeUpdates)assert.deepEqual(process.argv.slice(2).filter(arg=>!['--runtime-updates','--isolated'].includes(arg)),[],'Runtime offline gate accepts no arbitrary script/arguments');

assert(process.platform==='linux','The network-namespace gate is Linux only');
const namespace=await readlink('/proc/self/ns/net');
if(!process.argv.includes('--isolated')) {
  const child=spawn('unshare',['--user','--map-current-user','--keep-caps','--net','sh','-ec','ip link set lo up; exec setpriv --inh-caps=-all --ambient-caps=-all "$@"','offline-linux',process.execPath,...process.argv.slice(1),'--isolated'],{stdio:'inherit',env:{...process.env,OPENROTMG_PARENT_NETNS:namespace}});
  child.on('error',error=>{console.error(error);process.exitCode=1;});
  child.on('exit',(code,signal)=>{if(signal)console.error(`Isolated gate exited with ${signal}`);process.exitCode=code??1;});
} else {
  assert(process.getuid()!==0,'Consumer QA must remain non-root without a sandbox bypass');
  assert(process.env.OPENROTMG_PARENT_NETNS&&namespace!==process.env.OPENROTMG_PARENT_NETNS,'An actual private network namespace is required');
  const links=execFileSync('ip',['-j','address'],{encoding:'utf8'});
  assert.deepEqual(JSON.parse(links).map(link=>link.ifname),['lo']);
  const routes=execFileSync('ip',['route','show','table','all'],{encoding:'utf8'});
  assert(!routes.split('\n').some(line=>line&&!line.includes('dev lo')),'No external route may exist');
  const probes=[];
  for(const host of ['1.1.1.1','8.8.8.8'])await new Promise((ok,bad)=>{
    const socket=connect({host,port:443});socket.setTimeout(3000,()=>{socket.destroy();bad(Error('External probe timed out instead of proving absent OS route'));});
    socket.once('connect',()=>{socket.destroy();bad(Error('External egress unexpectedly succeeded'));});
    socket.once('error',error=>{try{assert.equal(error.code,'ENETUNREACH');probes.push({host,port:443,error:error.code});ok();}catch(cause){bad(cause);}});
  });
  const proof=resolve(runtimeUpdates?'.qa/runtime-updates/offline-proof.json':'.qa/integration/offline-proof.json');await mkdir(dirname(proof),{recursive:true});
  await writeFile(proof,JSON.stringify({uid:process.getuid(),namespace,parentNamespace:process.env.OPENROTMG_PARENT_NETNS,links:JSON.parse(links),routes,probes},null,2));
  const child=spawn(process.execPath,[runtimeUpdates?'scripts/runtime-updates-test.mjs':'scripts/package-test.mjs',...process.argv.slice(2).filter(arg=>!['--isolated','--runtime-updates'].includes(arg))],{stdio:'inherit',env:{...process.env,...(runtimeUpdates?{OPENROTMG_RUNTIME_UPDATE_OFFLINE_PROOF:proof}:{})}});
  child.on('error',error=>{console.error(error);process.exitCode=1;});
  child.on('exit',(code,signal)=>{if(signal)console.error(`Offline package test exited with ${signal}`);process.exitCode=code??1;});
}
