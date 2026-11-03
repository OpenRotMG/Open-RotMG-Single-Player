import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {windowsProcessIdentity} from './native-boundaries.mjs';

export async function closeWindowsEdge({context,protocol,identity,profile,record,expectedExecutable},operations={identity:windowsProcessIdentity,signal:(pid,signal)=>process.kill(pid,signal),waitForExit}) {
  const errors=[];
  if(protocol){let timer;try{await Promise.race([protocol.send('Browser.close'),new Promise((_,bad)=>timer=setTimeout(()=>bad(Error('Protocol close exceeded10s')),10000))]);}catch(error){errors.push(error);}finally{clearTimeout(timer);}}
  if(context&&!identity){record.browserExitVerification='unverified';try{await context.close();}catch(error){errors.push(error);}errors.push(Error('Fresh Edge identity was not captured; exit unverified'));}
  if(identity)try{
    if(!await operations.waitForExit(identity.pid)){
      errors.push(Error('Edge did not exit after protocol close'));const current=operations.identity(identity.pid);
      assert(current.started===identity.started&&current.argv===identity.argv&&current.argv.includes(profile)&&current.executable.toLowerCase()===identity.executable.toLowerCase(),'Immediate owned Edge identity required before signal');
      if(expectedExecutable)assert.equal(current.executable.toLowerCase(),expectedExecutable.toLowerCase(),'Never signal a redirected installed Edge image');
      operations.signal(identity.pid,'SIGTERM');record.cleanupSignal={...current,signal:'SIGTERM'};assert(await operations.waitForExit(identity.pid),'Edge cleanup unverified');
    }
    record.browserExited=true;await context.close();
  }catch(error){errors.push(error);}
  if(errors.length)throw new AggregateError(errors,errors.map(error=>String(error.stack??error)).join('\n'));
}
async function waitForExit(pid){const deadline=Date.now()+10000;while(alive(pid)&&Date.now()<deadline)await delay(100);return !alive(pid);}
function alive(pid){try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}
