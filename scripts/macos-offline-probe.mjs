import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,readFile,open} from 'node:fs/promises';
import {createServer} from 'node:http';
import {connect} from 'node:net';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {processArgv} from './process-argv.mjs';

assert(process.platform==='darwin'&&process.arch==='arm64'&&process.env.GITHUB_ACTIONS==='true','Offline diagnostics require an owned native macOS ARM64 CI VM');
const out=resolve('.qa/mac-offline-probe');await mkdir(out,{recursive:true});
// Restrict IP egress without denying Chromium's Unix-domain IPC or native sandbox setup.
const policy='(version 1)\n(allow default)\n(deny network-outbound (require-all (remote ip "*:*") (require-not (remote ip "localhost:*"))))\n';
const policyPath=join(out,'offline.sb'),policySha256=createHash('sha256').update(policy).digest('hex');
if(!process.argv.includes('--confined')) {
  await writeFile(policyPath,policy);
  const command=['/usr/bin/sandbox-exec','-f',policyPath,process.execPath,...process.argv.slice(1),'--confined'];
  const log=await open(join(out,'sandbox-process.log'),'wx');
  const child=spawn(command[0],command.slice(1),{stdio:['ignore','inherit',log.fd]});
  let spawnError;child.once('error',error=>spawnError=String(error));
  const outcome=await new Promise(ok=>child.once('close',(code,signal)=>ok({code,signal})));
  const launch={command,policySha256,...outcome,spawnError};
  try{await log.close();}catch(error){launch.logCloseError=String(error);}
  await writeFile(join(out,'launch.json'),JSON.stringify(launch,null,2));
  process.exitCode=launch.logCloseError?1:outcome.code??1;
} else {
  assert.equal(await readFile(policyPath,'utf8'),policy);
  const report={purpose:'Process-tree OS egress/normal Chromium capability diagnostics, NOT full game/default-browser/whole-VM acceptance',head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),os:process.platform,arch:process.arch,system:execFileSync('sw_vers',[],{encoding:'utf8'}),node:{pid:process.pid,argv:await processArgv(process.pid),version:process.version},policyPath,policy,policySha256,errors:[],externalTcp:[]};
  const tmp=await mkdtemp(join(process.env.RUNNER_TEMP,'mac-offline-'));Object.assign(process.env,{TMPDIR:tmp,TEMP:tmp,TMP:tmp});
  const server=createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<title>Mac offline capability diagnostic</title><h1>Offline WebGL2 diagnostic - not game acceptance</h1><pre id="result"></pre><canvas width="256" height="256"></canvas>');});
  let context,protocol,pid,identity;
  try {
    for(const host of ['1.1.1.1','8.8.8.8'])await new Promise((ok,bad)=>{
      const socket=connect({host,port:80});socket.setTimeout(3000,()=>{socket.destroy();bad(Error('TCP timeout is not OS-policy proof'));});
      socket.once('connect',()=>{socket.destroy();bad(Error('External TCP unexpectedly connected'));});
      socket.once('error',error=>{report.externalTcp.push({host,port:80,error:error.code});try{assert(['EPERM','EACCES'].includes(error.code),'Actual OS permission denial required');ok();}catch(cause){bad(cause);}});
    });
    await new Promise((ok,bad)=>{server.once('error',bad);server.listen(0,'127.0.0.1',ok);});
    const origin=`http://127.0.0.1:${server.address().port}`;report.origin=origin;
    assert((await (await fetch(origin)).text()).includes('Offline WebGL2 diagnostic'));report.nodeLoopback=true;
    const profile=join(tmp,'browser');report.profile=profile;
    context=await chromium.launchPersistentContext(profile,{headless:false,chromiumSandbox:true,ignoreDefaultArgs:true,args:['--remote-debugging-pipe',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--window-size=1000,800','about:blank'],env:process.env,timeout:30000});
    const browser=context.browser();assert(browser);protocol=await browser.newBrowserCDPSession();
    const {processInfo}=await protocol.send('SystemInfo.getProcessInfo');pid=processInfo.find(entry=>entry.type==='browser')?.id;assert(Number.isSafeInteger(pid));
    identity={pid,argv:await processArgv(pid),started:startIdentity(pid)};report.browser={...identity,version:browser.version(),systemInfo:await protocol.send('SystemInfo.getInfo')};
    assert(!/--no-sandbox|--disable-setuid-sandbox|--enable-unsafe-swiftshader|--disable-web-security|--use-angle|--ignore-gpu-blocklist/.test(identity.argv),'Normal browser and native sandbox policy must remain intact');
    const page=context.pages()[0];assert(page);await page.goto(origin);report.browserLoopback=true;
    report.webgl2=await page.evaluate(()=>{
      const gl=document.querySelector('canvas').getContext('webgl2'),result={supported:!!gl};
      if(gl){const debug=gl.getExtension('WEBGL_debug_renderer_info');Object.assign(result,{lost:gl.isContextLost(),version:gl.getParameter(gl.VERSION),vendor:gl.getParameter(gl.VENDOR),renderer:gl.getParameter(gl.RENDERER)});if(debug)result.unmaskedRenderer=gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);gl.clearColor(0.25,0.5,0.75,1);gl.clear(gl.COLOR_BUFFER_BIT);const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);result.pixel=Array.from(pixel);result.error=gl.getError();}
      document.querySelector('#result').textContent=JSON.stringify(result,null,2);return result;
    });
    assert(report.webgl2.supported&&!report.webgl2.lost,'Normal sandboxed WebGL2 must work inside the OS policy');assert.equal(report.webgl2.error,0);assert(report.webgl2.pixel.every((value,index)=>Math.abs(value-[64,128,191,255][index])<=1));
    const network=await context.newCDPSession(page),requests=new Map();report.browserNetworkFailures=[];
    network.on('Network.requestWillBeSent',event=>requests.set(event.requestId,event.request.url));
    network.on('Network.loadingFailed',event=>{if(requests.get(event.requestId)==='http://1.1.1.1/')report.browserNetworkFailures.push({url:requests.get(event.requestId),errorText:event.errorText,blockedReason:event.blockedReason});});
    await network.send('Network.enable');
    report.browserExternalFetch=await page.evaluate(async()=>{try{await fetch('http://1.1.1.1/',{mode:'no-cors',cache:'no-store',signal:AbortSignal.timeout(5000)});return {connected:true};}catch(error){return {error:String(error)};}});
    const deadline=Date.now()+3000;while(!report.browserNetworkFailures.length&&Date.now()<deadline)await delay(50);
    assert(!report.browserExternalFetch.connected&&report.browserNetworkFailures.some(event=>['net::ERR_NETWORK_ACCESS_DENIED','net::ERR_ACCESS_DENIED'].includes(event.errorText)),'Browser must report OS access denial, not CORS/timeout');
    await page.screenshot({path:join(out,'offline-webgl2.png')});report.status='passed';
  }catch(error){report.status='failed';report.errors.push(String(error.stack??error));console.error(report.errors.at(-1));await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));}
  finally {
    if(protocol){let timer;try{await Promise.race([protocol.send('Browser.close'),new Promise((_,bad)=>timer=setTimeout(()=>bad(Error('Protocol close exceeded10s')),10000))]);}catch(error){report.errors.push(`Protocol cleanup: ${error}`);}finally{clearTimeout(timer);}}
    if(pid)try{
      let deadline=Date.now()+10000;while(alive(pid)&&Date.now()<deadline)await delay(100);
      if(alive(pid)){
        report.errors.push('Browser did not exit after protocol close');const argv=await processArgv(pid),started=startIdentity(pid);
        assert(identity&&argv===identity.argv&&argv.includes(report.profile)&&started===identity.started,'Current owned browser identity required');process.kill(pid,'SIGTERM');report.cleanupSignal={pid,argv,started,signal:'SIGTERM'};
        deadline=Date.now()+10000;while(alive(pid)&&Date.now()<deadline)await delay(100);
      }
      report.browserExited=!alive(pid);assert(report.browserExited,'Browser cleanup unverified');if(context)await context.close();
    }catch(error){report.errors.push(`Browser cleanup: ${error}`);}
    try{if(server.listening){server.closeAllConnections();await new Promise((ok,bad)=>server.close(error=>error?bad(error):ok()));}}catch(error){report.errors.push(`Loopback cleanup: ${error}`);}
    if(report.errors.length){report.status='failed';process.exitCode=1;}
    await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,errors:report.errors},null,2));
  }
}
function startIdentity(pid){return execFileSync('ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8'}).trim();}
function alive(pid){try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}
