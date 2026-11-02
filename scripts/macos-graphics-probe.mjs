import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {release} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {processArgv} from './process-argv.mjs';

assert(process.platform==='darwin'&&process.env.GITHUB_ACTIONS==='true','This diagnostic requires an owned native macOS GitHub runner');
const out=resolve('.qa/mac-graphics-probe');await mkdir(out,{recursive:true});
const report={purpose:'Independent graphics capability diagnostics, NOT package/game acceptance',head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),os:process.platform,arch:process.arch,kernel:release(),system:execFileSync('sw_vers',[],{encoding:'utf8'}),displays:JSON.parse(execFileSync('system_profiler',['SPDisplaysDataType','-json'],{encoding:'utf8',timeout:30000})),configurations:[]};
const tmp=await mkdtemp(join(process.env.RUNNER_TEMP,'mac-gl-'));
const configurations=[
  {name:'normal',args:[]},
  {name:'angle-metal',args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist']},
  {name:'angle-opengl',args:['--use-gl=angle','--use-angle=gl','--ignore-gpu-blocklist']},
];
for(const configuration of configurations) {
  const entry={...configuration,profile:join(tmp,configuration.name),errors:[]};report.configurations.push(entry);
  let context,pid;
  try {
    context=await chromium.launchPersistentContext(entry.profile,{headless:false,chromiumSandbox:true,ignoreDefaultArgs:true,args:['--remote-debugging-pipe',`--user-data-dir=${entry.profile}`,'--no-first-run','--no-default-browser-check','--window-size=800,600',...configuration.args,'about:blank'],env:{...process.env,TMPDIR:tmp,TMP:tmp,TEMP:tmp},timeout:30000});
    const browser=context.browser();assert(browser,'Diagnostic browser connection required');
    const protocol=await browser.newBrowserCDPSession();
    const {processInfo}=await protocol.send('SystemInfo.getProcessInfo');pid=processInfo.find(process=>process.type==='browser')?.id;assert(Number.isSafeInteger(pid),'Actual browser PID required');
    entry.pid=pid;entry.argv=await processArgv(pid);entry.browserVersion=browser.version();
    assert(!/--no-sandbox|--disable-setuid-sandbox|--enable-unsafe-swiftshader|--disable-web-security/.test(entry.argv),'No security bypass is permitted');
    entry.systemInfo=await protocol.send('SystemInfo.getInfo');
    const page=context.pages()[0];assert(page,'Fresh browser initial page required');
    await page.setContent('<title>Mac WebGL2 capability diagnostic</title><h1>WebGL2 diagnostic — not game acceptance</h1><pre id="result"></pre><canvas width="256" height="256"></canvas>');
    entry.webgl2=await page.evaluate(()=>{
      const canvas=document.querySelector('canvas'),gl=canvas.getContext('webgl2');
      const result={supported:!!gl};
      if(gl){
        const debug=gl.getExtension('WEBGL_debug_renderer_info');
        Object.assign(result,{lost:gl.isContextLost(),version:gl.getParameter(gl.VERSION),vendor:gl.getParameter(gl.VENDOR),renderer:gl.getParameter(gl.RENDERER),debugRendererInfo:!!debug});
        if(debug)Object.assign(result,{unmaskedVendor:gl.getParameter(debug.UNMASKED_VENDOR_WEBGL),unmaskedRenderer:gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)});
        gl.clearColor(0.25,0.5,0.75,1);gl.clear(gl.COLOR_BUFFER_BIT);const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);result.pixel=Array.from(pixel);result.error=gl.getError();
      }
      document.querySelector('#result').textContent=JSON.stringify(result,null,2);return result;
    });
    if(entry.webgl2.supported){assert(!entry.webgl2.lost);assert.equal(entry.webgl2.error,0);assert(entry.webgl2.pixel.every((value,index)=>Math.abs(value-[64,128,191,255][index])<=1),'Actual WebGL2 clear/readback must match');}
    entry.status=entry.webgl2.supported?'supported':'unsupported';
    await page.screenshot({path:join(out,configuration.name+'.png')});
  }catch(error){entry.status='error';entry.errors.push(String(error.stack??error));process.exitCode=1;}
  finally {
    if(context){
      let timer;
      try{await Promise.race([context.close(),new Promise((_,bad)=>timer=setTimeout(()=>bad(Error('Browser close exceeded10s')),10000))]);}
      catch(error){entry.errors.push(`Browser cleanup: ${error}`);process.exitCode=1;if(pid&&alive(pid))process.kill(pid,'SIGTERM');}
      finally{clearTimeout(timer);}
    }
    if(pid){
      const deadline=Date.now()+10000;while(alive(pid)&&Date.now()<deadline)await delay(100);
      entry.browserExited=!alive(pid);if(!entry.browserExited){entry.errors.push(`Owned browser ${pid} did not exit; no successful cleanup claim`);process.exitCode=1;}
    }
    await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));
    console.log(`${configuration.name}: ${entry.status}; cleanup=${entry.browserExited}; errors=${entry.errors.length}`);
  }
}
function alive(pid){try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}
