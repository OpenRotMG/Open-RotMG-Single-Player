import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir,open,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {processArgv} from './process-argv.mjs';

assert(process.platform==='darwin'&&process.env.GITHUB_ACTIONS==='true','Safari diagnostics require an owned native macOS CI runner');
const out=resolve('.qa/mac-safari-probe');await mkdir(out,{recursive:true});
const report={purpose:'Normal built-in Safari WebDriver capability diagnostics, NOT game/default-browser acceptance',head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),os:process.platform,arch:process.arch,system:execFileSync('sw_vers',[],{encoding:'utf8'}),driverVersion:execFileSync('/usr/bin/safaridriver',['--version'],{encoding:'utf8'}).trim(),errors:[]};
let driver,session,driverIdentity,endpoint;
const page=createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<title>Safari WebGL2 diagnostic</title><h1>Safari WebGL2 diagnostic - not game acceptance</h1><pre id="result"></pre><canvas width="256" height="256"></canvas>');});
const log=await open(join(out,'safaridriver.log'),'wx');
try {
  await listen(page);const origin=`http://127.0.0.1:${page.address().port}`;
  const allocation=createServer();await listen(allocation);const port=allocation.address().port;await new Promise(ok=>allocation.close(ok));
  endpoint=`http://127.0.0.1:${port}`;
  driver=spawn('/usr/bin/safaridriver',['--port',String(port)],{stdio:['ignore',log.fd,log.fd]});
  let spawnError;driver.once('error',error=>spawnError=error);
  const deadline=Date.now()+20000;let ready=false;
  while(!ready&&Date.now()<deadline){
    if(spawnError)throw spawnError;
    assert(driver.exitCode===null&&driver.signalCode===null,'Owned Safari driver exited before readiness');
    try{report.driverStatus=await request('GET','/status',undefined,1000);ready=true;}
    catch(error){if(!['TypeError','TimeoutError'].includes(error.name))throw error;}
    if(!ready)await delay(100);
  }
  assert(ready,'Owned Safari driver readiness deadline exceeded');
  const listener=execFileSync('/usr/sbin/lsof',['-nP',`-iTCP:${port}`,'-sTCP:LISTEN','-Fpn'],{encoding:'utf8'}).trim();
  const owners=listener.split('\n').filter(line=>line.startsWith('p'));
  const addresses=listener.split('\n').filter(line=>line.startsWith('n'));
  assert.deepEqual(owners,[`p${driver.pid}`],'Only the spawned driver may own its allocated endpoint');
  assert(addresses.length&&addresses.every(line=>/^n(?:127\.0\.0\.1|\[::1\]|localhost):\d+$/.test(line)),'Driver must listen only on loopback');
  driverIdentity={pid:driver.pid,argv:await processArgv(driver.pid),started:startIdentity(driver.pid)};
  assert(driverIdentity.argv.includes('/usr/bin/safaridriver')&&driverIdentity.argv.includes(String(port)),'Actual owned driver argv required');
  report.driver={...driverIdentity,endpoint,listener};
  const created=await request('POST','/session',{capabilities:{alwaysMatch:{browserName:'safari'}}},30000);
  session=created.sessionId;assert(typeof session==='string'&&session.length,'Owned Safari automation session ID required');
  report.session={id:session,capabilities:created.capabilities};
  assert.equal(created.capabilities.browserName.toLowerCase(),'safari','The native Safari driver must identify Safari');
  await request('POST',`/session/${session}/timeouts`,{script:15000,pageLoad:20000,implicit:0});
  await request('POST',`/session/${session}/url`,{url:origin});
  report.webgl2=await request('POST',`/session/${session}/execute/sync`,{script:`return (${graphicsCapability.toString()})();`,args:[]});
  if(report.webgl2.supported){assert(!report.webgl2.lost);assert.equal(report.webgl2.error,0);assert(report.webgl2.pixel.every((value,index)=>Math.abs(value-[64,128,191,255][index])<=1),'Actual WebGL2 clear/readback must match');}
  report.status=report.webgl2.supported?'supported':'unsupported';
  const screenshot=Buffer.from(await request('GET',`/session/${session}/screenshot`),'base64');assert.equal(screenshot.subarray(0,8).toString('hex'),'89504e470d0a1a0a');await writeFile(join(out,'safari.png'),screenshot);
}catch(error){report.status='error';report.errors.push(String(error.stack??error));process.exitCode=1;}
finally {
  if(session)try{
    await request('DELETE',`/session/${session}`,undefined,15000);
    const response=await fetch(endpoint+`/session/${session}/url`,{signal:AbortSignal.timeout(5000)}),invalid=await response.json();
    assert.equal(invalid.value.error,'invalid session id','Deleted automation session must no longer accept commands');report.sessionDeleted=true;
  }catch(error){report.errors.push(`Automation session cleanup: ${error}`);process.exitCode=1;}
  if(driver&&driver.exitCode===null&&driver.signalCode===null)try{
    const argv=await processArgv(driver.pid),started=startIdentity(driver.pid);
    assert(driverIdentity&&argv===driverIdentity.argv&&started===driverIdentity.started,'Current owned Safari driver identity required before SIGTERM');
    driver.kill('SIGTERM');report.driverSignal='SIGTERM';
  }catch(error){report.errors.push(`Driver ownership/cleanup: ${error}; no unverified signal sent`);process.exitCode=1;}
  if(driver){
    const deadline=Date.now()+10000;while(driver.exitCode===null&&driver.signalCode===null&&Date.now()<deadline)await delay(100);
    report.driverExited=driver.exitCode!==null||driver.signalCode!==null;
    if(!report.driverExited){report.errors.push('Owned driver did not exit; no successful cleanup claim');process.exitCode=1;driver.unref();}
  }
  if(page.listening){page.closeAllConnections();await new Promise(ok=>page.close(ok));}
  await log.close();await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({status:report.status,sessionDeleted:report.sessionDeleted,driverExited:report.driverExited,errors:report.errors},null,2));
}
async function request(method,path,body,timeout=20000){
  const response=await fetch(endpoint+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(timeout)});
  const data=JSON.parse(await response.text());
  if(!response.ok||data.value?.error)throw Error(`Safari WebDriver ${method} ${path}: HTTP${response.status} ${JSON.stringify(data.value)}`);
  return data.value;
}
async function listen(server){await new Promise((ok,bad)=>{server.once('error',bad);server.listen(0,'127.0.0.1',ok);});}
function startIdentity(pid){return execFileSync('ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8'}).trim();}
function graphicsCapability(){
  const gl=document.querySelector('canvas').getContext('webgl2');const result={supported:!!gl,userAgent:navigator.userAgent,navigatorVendor:navigator.vendor,webdriver:navigator.webdriver};
  if(gl){
    const debug=gl.getExtension('WEBGL_debug_renderer_info');Object.assign(result,{lost:gl.isContextLost(),version:gl.getParameter(gl.VERSION),vendor:gl.getParameter(gl.VENDOR),renderer:gl.getParameter(gl.RENDERER),debugRendererInfo:!!debug});
    if(debug)Object.assign(result,{unmaskedVendor:gl.getParameter(debug.UNMASKED_VENDOR_WEBGL),unmaskedRenderer:gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)});
    gl.clearColor(0.25,0.5,0.75,1);gl.clear(gl.COLOR_BUFFER_BIT);const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);result.pixel=Array.from(pixel);result.error=gl.getError();
  }
  document.querySelector('#result').textContent=JSON.stringify(result,null,2);return result;
}
