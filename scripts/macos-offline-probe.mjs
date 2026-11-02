import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {execFile,execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {processArgv} from './process-argv.mjs';
import {closePrePidOfflineContext,persistMacOfflineEvidence,macOfflinePayloadCommands} from './macos-offline-evidence.mjs';

assert(process.platform==='darwin'&&process.arch==='arm64'&&process.env.GITHUB_ACTIONS==='true','Offline diagnostics require an owned native macOS ARM64 CI VM');
const out=resolve('.qa/mac-offline-probe'),policyPath=join(out,'offline.sb');
const policy='(version 1)\n(allow default)\n(deny network-outbound (require-all (remote ip "*:*") (require-not (remote ip "localhost:*"))))\n';
const report={purpose:'OS-confined Node/normal Chromium payload diagnostics, NOT full game/default-browser/whole-VM acceptance',observerOutsidePolicy:true,errors:[],policy,policyPath,policySha256:createHash('sha256').update(policy).digest('hex'),os:process.platform,arch:process.arch};
const server=createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<title>Mac offline capability diagnostic</title><h1>Offline WebGL2 diagnostic - not game acceptance</h1><pre id="result"></pre><canvas width="256" height="256"></canvas>');});
let context,protocol,pid,identity;
try {
  await mkdir(out,{recursive:true});await writeFile(policyPath,policy);
  report.head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();report.system=execFileSync('sw_vers',[],{encoding:'utf8'});report.observer={pid:process.pid,argv:await processArgv(process.pid),version:process.version};
  const tmp=await mkdtemp(join(process.env.RUNNER_TEMP,'mac-offline-'));Object.assign(process.env,{TMPDIR:tmp,TEMP:tmp,TMP:tmp});
  const profile=join(tmp,'browser'),commands=macOfflinePayloadCommands(policyPath,process.execPath,resolve('scripts/macos-offline-canary.mjs'),chromium.executablePath(),profile);
  const nodeCommand=commands.node;report.nodeCommand=nodeCommand;
  report.nodeProcess=await new Promise(ok=>execFile(nodeCommand[0],nodeCommand.slice(1),{encoding:'utf8',timeout:15000},(error,stdout,stderr)=>ok({exitCode:error?.code??0,error:error&&String(error),stdout,stderr})));
  report.nodeProof=JSON.parse(report.nodeProcess.stdout);assert.equal(report.nodeProcess.exitCode,0,'Confined Node canary must prove OS denial and loopback');assert.equal(report.nodeProof.status,'passed');assert.equal(report.nodeProof.policySha256,report.policySha256);
  await new Promise((ok,bad)=>{server.once('error',bad);server.listen(0,'127.0.0.1',ok);});
  const origin=`http://127.0.0.1:${server.address().port}`;report.origin=origin;report.profile=profile;
  // The observer stays outside; both payloads execute through the same unchanged OS policy.
  report.browserCommand=commands.browser;
  context=await chromium.launchPersistentContext(profile,{executablePath:commands.browser[0],headless:false,chromiumSandbox:true,ignoreDefaultArgs:true,args:commands.browser.slice(1),env:process.env,timeout:30000});
  const browser=context.browser();assert(browser);protocol=await browser.newBrowserCDPSession();
  const {processInfo}=await protocol.send('SystemInfo.getProcessInfo');const observedPid=processInfo.find(entry=>entry.type==='browser')?.id;report.observedBrowserPid=observedPid;assert(Number.isSafeInteger(observedPid)&&observedPid>0);
  const observedIdentity={pid:observedPid,argv:await processArgv(observedPid),started:startIdentity(observedPid)};pid=observedPid;identity=observedIdentity;
  report.browser={...identity,version:browser.version(),systemInfo:await protocol.send('SystemInfo.getInfo')};
  assert(!/--no-sandbox|--disable-setuid-sandbox|--enable-unsafe-swiftshader|--disable-web-security|--use-angle|--ignore-gpu-blocklist/.test(identity.argv),'Normal browser and native sandbox must remain intact');
  const page=context.pages()[0];assert(page);await page.goto(origin);report.browserLoopback=true;
  report.webgl2=await page.evaluate(graphicsCapability);assert(report.webgl2.supported&&!report.webgl2.lost,'Normal sandboxed WebGL2 must work inside OS policy');assert.equal(report.webgl2.error,0);assert(report.webgl2.pixel.every((value,index)=>Math.abs(value-[64,128,191,255][index])<=1));
  const network=await context.newCDPSession(page),requests=new Map();report.browserNetworkFailures=[];
  network.on('Network.requestWillBeSent',event=>requests.set(event.requestId,event.request.url));network.on('Network.loadingFailed',event=>{if(requests.get(event.requestId)==='http://1.1.1.1/')report.browserNetworkFailures.push({url:requests.get(event.requestId),errorText:event.errorText,blockedReason:event.blockedReason});});await network.send('Network.enable');
  report.browserExternalFetch=await page.evaluate(async()=>{try{await fetch('http://1.1.1.1/',{mode:'no-cors',cache:'no-store',signal:AbortSignal.timeout(5000)});return {connected:true};}catch(error){return {error:String(error)};}});
  const deadline=Date.now()+3000;while(!report.browserNetworkFailures.length&&Date.now()<deadline)await delay(50);
  assert(!report.browserExternalFetch.connected&&report.browserNetworkFailures.some(event=>['net::ERR_NETWORK_ACCESS_DENIED','net::ERR_ACCESS_DENIED'].includes(event.errorText)),'Browser must report OS access denial, not CORS/timeout');
  await page.screenshot({path:join(out,'offline-webgl2.png')});report.status='passed';
}catch(error){report.status='failed';report.errors.push(String(error.stack??error));process.exitCode=1;await persistMacOfflineEvidence(report,join(out,'result.json'));}
finally {
  if(protocol){let timer;try{await Promise.race([protocol.send('Browser.close'),new Promise((_,bad)=>timer=setTimeout(()=>bad(Error('Protocol close exceeded10s')),10000))]);}catch(error){report.errors.push(`Protocol cleanup: ${error}`);}finally{clearTimeout(timer);}}
  if(context&&!pid)await closePrePidOfflineContext(context,report);
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
  if(!await persistMacOfflineEvidence(report,join(out,'result.json')))process.exitCode=1;
  console.log(JSON.stringify({status:report.status,errors:report.errors},null,2));
}
function startIdentity(pid){return execFileSync('ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8'}).trim();}
function alive(pid){try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}
function graphicsCapability(){const gl=document.querySelector('canvas').getContext('webgl2'),result={supported:!!gl};if(gl){const debug=gl.getExtension('WEBGL_debug_renderer_info');Object.assign(result,{lost:gl.isContextLost(),version:gl.getParameter(gl.VERSION),vendor:gl.getParameter(gl.VENDOR),renderer:gl.getParameter(gl.RENDERER)});if(debug)result.unmaskedRenderer=gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);gl.clearColor(0.25,0.5,0.75,1);gl.clear(gl.COLOR_BUFFER_BIT);const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);result.pixel=Array.from(pixel);result.error=gl.getError();}document.querySelector('#result').textContent=JSON.stringify(result,null,2);return result;}
