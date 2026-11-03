import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {readFile,writeFile,readdir,stat,open} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {sha256} from './assets.mjs';

export async function rejectStateContender({binary,userData,out,env,check,report}) {
  const config=JSON.parse(await readFile(join(userData,'desktop-config.json'),'utf8'));
  config.bind='127.0.0.1:0';config.origin='http://127.0.0.1:0';
  const path=join(out,'contender-config.json');await writeFile(path,JSON.stringify(config));
  const snapshot=async()=>Object.fromEntries(await Promise.all((await readdir(config.state)).filter(name=>/^game\.db(?:-wal)?$/.test(name)).map(async name=>[name,sha256(await readFile(join(config.state,name)))])));
  const before=await snapshot();let result;
  try{execFileSync(binary,['--desktop','--config',path],{env,encoding:'utf8',timeout:10000,stdio:['pipe','pipe','pipe']});throw Error('A second state owner unexpectedly succeeded');}
  catch(error){assert.equal(error.status,1,`Contender must fail with exit1, not hang or crash: ${error}`);result={code:error.status,stdout:String(error.stdout),stderr:String(error.stderr)};}
  await writeFile(join(out,'state-contender.log'),result.stdout+result.stderr);
  check('independent server state-lock contender rejects before listening on a distinct endpoint',/state lock held/.test(result.stdout+result.stderr)&&!/game frontdoor listening/.test(result.stdout+result.stderr));
  const after=await snapshot();assert.deepEqual(after,before,'Rejected state owner must not mutate DB/WAL');
  check('rejected state owner leaves exact DB/WAL bytes unchanged',true);
  report.stateContention={...result,before,after};
}
export async function crashReleasedRestart({binary,userData,out,env,origin,game,check,report,onReady}) {
  const lock=join(userData,'state/state.lock'),before=await stat(lock);
  const logPath=join(out,'server-crash-restart.jsonl'),log=await open(logPath,'wx');
  const requestedAt=Date.now();const child=spawn(binary,['--desktop','--config',join(userData,'desktop-config.json')],{env,stdio:['pipe',log.fd,log.fd]});
  let spawnError;child.once('error',error=>spawnError=error);
  const exited=new Promise(ok=>child.once('close',(code,signal)=>ok({code,signal})));
  try {
    const deadline=Date.now()+650000;let ready=false,readyHealth;
    while(!ready&&Date.now()<deadline){
      if(spawnError)throw spawnError;
      assert(child.exitCode===null&&child.signalCode===null,'Restarted owner exited before readiness');
      try{const health=await (await fetch(origin+'/health',{signal:AbortSignal.timeout(1500)})).json();ready=health.process===child.pid;if(ready)readyHealth=health;}
      catch(error){if(!['TypeError','TimeoutError'].includes(error.name))throw error;}
      if(!ready)await delay(200);
    }
    assert(ready,'Crashed server OS lock must release for independent restart');if(onReady)await onReady({pid:child.pid,health:readyHealth,requestedAt});
    const after=await stat(lock);
    check('actual server crash releases OS ownership without deleting or replacing state.lock',before.ino===after.ino&&before.dev===after.dev);
    await game.verify();
    report.serverCrashRestart={pid:child.pid,lockBefore:{ino:before.ino,dev:before.dev},lockAfter:{ino:after.ino,dev:after.dev},logPath};
  } finally {
    if(child.exitCode===null&&child.signalCode===null)child.stdin.end('stop\n');
    let timer;
    try{const result=await Promise.race([exited,new Promise((_,bad)=>timer=setTimeout(()=>bad(Error(`Independent QA restart PID ${child.pid} did not drain; NOT force-killed`)),650000))]);assert.equal(result.code,0,'Independent restarted owner must stop durably');}
    finally{clearTimeout(timer);await log.close();}
  }
  check('active-character server-crash restart retains changed inventory and stops durably',(await readFile(logPath,'utf8')).includes('shutdown persistence complete'));
}
