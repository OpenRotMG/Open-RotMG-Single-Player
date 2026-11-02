import {_electron as electron} from '@playwright/test';
import {mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';

export async function failureCloseTests({out,native,env,check,report}) {
  const args=profile=>[`--user-data-dir=${profile}`,...(process.platform==='linux'?['--ozone-platform=x11']:[])];
  const launch=async profile=>{
    const app=await electron.launch({executablePath:native,args:args(profile),chromiumSandbox:true,env,timeout:30000});
    const page=await app.firstWindow();await page.waitForFunction(()=>!!window.launcher);
    await app.evaluate(({dialog})=>{
      globalThis.qaDialogs=[];
      dialog.showErrorBox=(title,body)=>globalThis.qaDialogs.push({title,body});
    });
    return {app,page,child:app.process(),pid:await app.evaluate(()=>process.pid)};
  };
  for(const kind of ['delayed-marker','unwritable-marker']) {
    const profile=join(out,kind);let current,server;
    try {
      current=await launch(profile);
      const {app,page,child,pid}=current;
      if(kind==='delayed-marker')await app.evaluate(()=>{
        const fs=process.getBuiltinModule('fs/promises'),write=fs.writeFile;
        const pending=new Promise(ok=>globalThis.qaReleaseFailureMarker=ok);
        fs.writeFile=async(path,...args)=>{
          if(String(path).endsWith('shutdown-failed.json'))await pending;
          return write(path,...args);
        };
      });
      await page.getByRole('button',{name:'Start Server',exact:true}).click();
      await wait(async()=>(await page.evaluate(()=>window.launcher.status())).status==='ready','failure-case child readiness',650000);
      server=(await page.evaluate(()=>window.launcher.status())).pid;
      if(kind==='unwritable-marker')await mkdir(join(profile,'shutdown-failed.json'));
      process.kill(server,'SIGKILL');
      await wait(async()=>{const view=await page.evaluate(()=>window.launcher.status());return view.status==='failed'&&!view.pid;},'failed child exits',10000);
      const screenshot=join(out,`${kind}.png`);await page.screenshot({path:screenshot});report.screenshots.push(screenshot);
      const started=performance.now();
      await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
      if(kind==='delayed-marker') {
        await delay(200);
        check('immediate Close retains launcher ownership during delayed failure-marker IO',alive(pid));
        const second=spawn(native,args(profile),{env,stdio:'ignore'});
        await wait(()=>second.exitCode!==null||second.signalCode!==null,'second launcher refusal during pending gate',10000);
        check('failure marker pending: second launcher cannot take ownership',second.exitCode===0&&alive(pid));
        await app.evaluate(()=>globalThis.qaReleaseFailureMarker());
        await wait(()=>!alive(pid)&&child.exitCode!==null,'Close waits for marker then exits',10000);current=undefined;
        const marker=JSON.parse(await readFile(join(profile,'shutdown-failed.json'),'utf8'));
        check('failed shutdown Close exits only after marker write completes',child.exitCode===1&&marker.error.includes('without verified shutdown')&&performance.now()-started>=200);
        current=await launch(profile);
        await current.page.getByRole('button',{name:'Start Server',exact:true}).click();
        await wait(async()=>(await current.page.evaluate(()=>window.launcher.status())).message.includes('Previous server shutdown'),'relaunch failure gate',10000);
        check('immediate failed-shutdown Close and relaunch cannot start another child',!(await current.page.evaluate(()=>window.launcher.status())).pid);
        await current.app.close();current=undefined;
      } else {
        await wait(async()=>(await app.evaluate(()=>globalThis.qaDialogs)).some(dialog=>dialog.title==='Failure gate was NOT recorded'),'marker IO error dialog',10000);
        check('actual marker IO failure is explicit and Close retains ownership',alive(pid)&&(await page.evaluate(()=>window.launcher.status())).message.includes('NOT recorded'));
        const second=spawn(native,args(profile),{env,stdio:'ignore'});
        await wait(()=>second.exitCode!==null||second.signalCode!==null,'second launcher refusal after failed marker IO',10000);
        check('marker write failure never silently releases single-instance ownership',second.exitCode===0&&alive(pid));
        report.failureMarkerErrorDialogs=await app.evaluate(()=>globalThis.qaDialogs);
      }
    } finally {
      if(current){
        if(server&&alive(server)){
          try{await current.page.evaluate(()=>window.launcher.stop());}
          catch(error){report.errors.push(`failure regression cleanup drain: ${error}`);}
          assert(!alive(server),'Failure regression cleanup must not abandon its server');
        }
        // Unwritable-gate tests must explicitly terminate their owned failed launcher; this is not a successful Close/save.
        const pid=current.pid;
        if(alive(pid)){process.kill(pid,'SIGKILL');await wait(()=>!alive(pid),'owned failed launcher teardown',10000);}
      }
    }
  }
}
function alive(pid){try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}
async function wait(predicate,message,timeout){const deadline=performance.now()+timeout;do{if(await predicate())return;await delay(100);}while(performance.now()<deadline);throw Error(`Timed out waiting for ${message}`);}
