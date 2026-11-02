import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {spawnSync,execFile} from 'node:child_process';
import {mkdir,mkdtemp,copyFile,cp,readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {connect} from 'node:net';
import {join,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {windowsPowerShellExecutable} from './native-boundaries.mjs';
import {tree} from './assets.mjs';
import {cleanupWindowsFirewallRules,windowsOfflineCanaryResult,verifyWindowsOfflineCanary} from './windows-firewall-cleanup.mjs';

assert(process.platform==='win32'&&process.arch==='x64'&&process.env.GITHUB_ACTIONS==='true','Offline diagnostics require an owned native Windows x64 CI VM');
if(process.argv.includes('--node-policy-check')) {
  const result={status:'running',pid:process.pid,executable:process.execPath,argv:process.argv,externalTcp:[],errors:[]};
  const server=createServer((_request,response)=>response.end('loopback-ok'));
  try{
    for(const host of ['1.1.1.1','8.8.8.8'])result.externalTcp.push(await deniedTcp(host));
    await listen(server);assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}`)).text(),'loopback-ok');result.loopback=true;result.status='passed';
  }catch(error){result.status='failed';result.errors.push(String(error.stack??error));process.exitCode=1;}
  finally{try{if(server.listening){server.closeAllConnections();await new Promise((ok,bad)=>server.close(error=>error?bad(error):ok()));}}catch(error){result.errors.push(String(error));result.status='failed';process.exitCode=1;}console.log(JSON.stringify(result));}
} else {
  const out='.qa/windows-offline-probe';
  const ranges=['0.0.0.0-126.255.255.255','128.0.0.0-255.255.255.255','::/128','::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'];
  const profileQuery="Get-NetFirewallProfile | Sort-Object Name | Select-Object Name,@{n='Enabled';e={$_.Enabled.ToString()}},@{n='DefaultInboundAction';e={$_.DefaultInboundAction.ToString()}},@{n='DefaultOutboundAction';e={$_.DefaultOutboundAction.ToString()}}";
  const report={purpose:'Per-executable OS firewall/normal graphics diagnostic, NOT game/default-browser/whole-VM acceptance',status:'initializing',os:process.platform,arch:process.arch,remoteAddresses:ranges,errors:[]};
  let context,protocol,identity,server;
  try {
    await mkdir(out,{recursive:true});report.head=psGitHead();report.engine=windowsPowerShellExecutable();
    const tmp=await mkdtemp(join(process.env.RUNNER_TEMP,'win offline-'));
    const node=join(tmp,'owned-node.exe'),chromeDirectory=join(tmp,'owned-chromium'),chrome=join(chromeDirectory,'chrome.exe'),profile=join(tmp,'browser-profile');
    const group='openrotmg-offline-'+randomUUID(),plans=[{name:group+'-node',program:node},{name:group+'-chromium',program:chrome}];report.rulePlans=plans;
    server=createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<title>Windows offline diagnostic</title><h1>Offline WebGL2 diagnostic - not game acceptance</h1><pre id="result"></pre><canvas width="256" height="256"></canvas>');});
    const sourceDirectory=dirname(chromium.executablePath());report.chromiumImage={sourceDirectory,copyDirectory:chromeDirectory,source:await tree(sourceDirectory,[''])};
    await copyFile(process.execPath,node);await cp(sourceDirectory,chromeDirectory,{recursive:true,verbatimSymlinks:true});
    report.chromiumImage.copy=await tree(chromeDirectory,['']);assert.deepEqual(report.chromiumImage.copy,report.chromiumImage.source,'Complete copied Chromium relative-path/hash inventory must match');report.chromiumImage.verified=true;
    report.programs=[];for(const [source,copy] of [[process.execPath,node],[chromium.executablePath(),chrome]]){const sourceHash=hash(await readFile(source)),copyHash=hash(await readFile(copy));assert.equal(copyHash,sourceHash);report.programs.push({source,copy,sha256:copyHash});}
    report.initialFirewall=ps(`Import-Module NetSecurity -ErrorAction Stop; [pscustomobject]@{engine=$PSVersionTable.PSVersion.ToString();module=(Get-Module NetSecurity).Path;administrator=([System.Security.Principal.WindowsPrincipal]::new([System.Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator);service=(Get-Service MpsSvc).Status.ToString();profiles=@(${profileQuery});connections=@(Get-NetConnectionProfile | Select-Object Name,NetworkCategory,InterfaceIndex)} | ConvertTo-Json -Depth 6 -Compress`);
    assert.equal(report.initialFirewall.administrator,true,'Owned CI user must already have firewall rule permission; no elevation is attempted');
    assert.equal(report.initialFirewall.service,'Running','OS firewall service must already be running; no global change is allowed');
    assert(report.initialFirewall.profiles.some(entry=>entry.Enabled==='True'),'OS firewall profiles are disabled; no global change is allowed');
    report.preexistingRules=readRules(plans.map(plan=>plan.name));assert.equal(report.preexistingRules.length,0,'Never modify or remove a preexisting rule');
    report.ruleCleanupRegistered=plans.map(plan=>plan.name);
    ps(`Import-Module NetSecurity -ErrorAction Stop; $data=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()); foreach($plan in $data.plans) { New-NetFirewallRule -Name $plan.name -DisplayName $plan.name -Group $data.group -PolicyStore PersistentStore -Direction Outbound -Action Block -Enabled True -Profile Any -Protocol Any -Program $plan.program -RemoteAddress $data.ranges -ErrorAction Stop | Out-Null }; '{}'`,{plans,group,ranges});
    report.actualRules=readRules(plans.map(plan=>plan.name));assert.equal(report.actualRules.length,2);
    for(const plan of plans){const actual=report.actualRules.find(rule=>rule.name===plan.name);assert(actual&&actual.enabled==='True'&&actual.direction==='Outbound'&&actual.action==='Block'&&actual.program.toLowerCase()===plan.program.toLowerCase(),'Actual program-scoped block rule required');}
    const proof=await new Promise(ok=>execFile(node,[process.argv[1],'--node-policy-check'],{encoding:'utf8',timeout:15000,windowsHide:true},(error,stdout,stderr)=>ok(windowsOfflineCanaryResult(error,stdout,stderr))));
    report.nodeProcess=proof;report.nodeProof=verifyWindowsOfflineCanary(proof,node);
    await listen(server);const origin=`http://127.0.0.1:${server.address().port}`;report.origin=origin;
    context=await chromium.launchPersistentContext(profile,{executablePath:chrome,headless:false,chromiumSandbox:true,ignoreDefaultArgs:true,args:['--remote-debugging-pipe',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--window-size=1000,800','about:blank'],timeout:30000});
    const browser=context.browser();assert(browser);protocol=await browser.newBrowserCDPSession();const {processInfo}=await protocol.send('SystemInfo.getProcessInfo');const pid=processInfo.find(entry=>entry.type==='browser')?.id;assert(Number.isSafeInteger(pid)&&pid>0);
    identity=processIdentity(pid);report.browser={...identity,version:browser.version(),systemInfo:await protocol.send('SystemInfo.getInfo')};
    assert(identity.executable.toLowerCase()===chrome.toLowerCase()&&identity.argv.includes(profile));assert(!/--no-sandbox|--disable-setuid-sandbox|--enable-unsafe-swiftshader|--disable-web-security|--use-angle|--ignore-gpu-blocklist/.test(identity.argv),'Normal Chromium sandbox/renderer configuration required');
    const page=context.pages()[0];assert(page);await page.goto(origin);report.browserLoopback=true;
    report.webgl2=await page.evaluate(graphicsCapability);assert(report.webgl2.supported&&!report.webgl2.lost,'Normal sandboxed WebGL2 required');assert.equal(report.webgl2.error,0);assert(report.webgl2.pixel.every((value,index)=>Math.abs(value-[64,128,191,255][index])<=1));
    const network=await context.newCDPSession(page),requests=new Map();report.browserNetworkFailures=[];
    network.on('Network.requestWillBeSent',event=>requests.set(event.requestId,event.request.url));network.on('Network.loadingFailed',event=>{if(requests.get(event.requestId)==='http://1.1.1.1/')report.browserNetworkFailures.push({url:requests.get(event.requestId),errorText:event.errorText,blockedReason:event.blockedReason});});await network.send('Network.enable');
    report.browserExternalFetch=await page.evaluate(async()=>{try{await fetch('http://1.1.1.1/',{mode:'no-cors',cache:'no-store',signal:AbortSignal.timeout(5000)});return {connected:true};}catch(error){return {error:String(error)};}});
    const deadline=Date.now()+3000;while(!report.browserNetworkFailures.length&&Date.now()<deadline)await delay(50);
    assert(!report.browserExternalFetch.connected&&report.browserNetworkFailures.some(entry=>['net::ERR_NETWORK_ACCESS_DENIED','net::ERR_ACCESS_DENIED'].includes(entry.errorText)),'Browser must report actual OS access denial, not CORS/timeout');
    await page.screenshot({path:join(out,'offline-webgl2.png')});report.status='passed';
  }catch(error){report.status='failed';report.errors.push(String(error.stack??error));process.exitCode=1;await persist();}
  finally {
    if(protocol){let timer;try{await Promise.race([protocol.send('Browser.close'),new Promise((_,bad)=>timer=setTimeout(()=>bad(Error('Protocol close exceeded10s')),10000))]);}catch(error){report.errors.push(`Protocol cleanup: ${error}`);}finally{clearTimeout(timer);}}
    if(context&&!identity)try{report.browserExitVerification='unverified';await context.close();}catch(error){report.errors.push(`Fresh pre-identity framework cleanup: ${error}`);}
    if(identity)try{
      let deadline=Date.now()+10000;while(alive(identity.pid)&&Date.now()<deadline)await delay(100);
      if(alive(identity.pid)){
        report.errors.push('Browser did not exit after protocol close');const current=processIdentity(identity.pid);
        assert(current.started===identity.started&&current.argv===identity.argv&&current.executable===identity.executable,'Current owned browser identity required before SIGTERM');process.kill(identity.pid,'SIGTERM');report.browserCleanupSignal={...current,signal:'SIGTERM'};
        deadline=Date.now()+10000;while(alive(identity.pid)&&Date.now()<deadline)await delay(100);
      }
      report.browserExited=!alive(identity.pid);assert(report.browserExited,'Browser exit unverified');if(context)await context.close();
    }catch(error){report.errors.push(`Browser cleanup: ${error}`);}
    try{if(server?.listening){server.closeAllConnections();await new Promise((ok,bad)=>server.close(error=>error?bad(error):ok()));}}catch(error){report.errors.push(`HTTP cleanup: ${error}`);}
    if(report.ruleCleanupRegistered){
      await cleanupWindowsFirewallRules(report,report.ruleCleanupRegistered,{observe:readRules,remove:name=>ps(`Import-Module NetSecurity -ErrorAction Stop; $name=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()); try { Remove-NetFirewallRule -Name $name -PolicyStore PersistentStore -ErrorAction Stop; [pscustomobject]@{name=$name;removed=$true} | ConvertTo-Json -Compress } catch { [pscustomobject]@{name=$name;removed=$false;errorId=$_.FullyQualifiedErrorId;category=$_.CategoryInfo.Category.ToString();detail=($_ | Out-String)} | ConvertTo-Json -Compress }`,name)});
      try{report.finalFirewallProfiles=ps(`Import-Module NetSecurity -ErrorAction Stop; @(${profileQuery}) | ConvertTo-Json -Depth 4 -Compress`);assert.deepEqual(report.finalFirewallProfiles,report.initialFirewall.profiles,'Global firewall profile policy must remain unchanged');}catch(error){report.errors.push(`Global profile observation: ${error}`);}
    }
    if(report.errors.length){report.status='failed';process.exitCode=1;}await persist();console.log(JSON.stringify({status:report.status,errors:report.errors},null,2));
  }
  async function persist(){console.error(JSON.stringify(report,null,2));try{await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));}catch(error){report.status='failed';report.errors.push(`Receipt persistence: ${error}`);process.exitCode=1;console.error(JSON.stringify(report,null,2));}}
}
function hash(bytes){return createHash('sha256').update(bytes).digest('hex');}
function psGitHead(){const result=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'});assert.equal(result.status,0);return result.stdout.trim();}
function ps(script,input){const result=spawnSync(windowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop'; ${script}`],{encoding:'utf8',input:input===undefined?undefined:JSON.stringify(input),timeout:30000});assert.equal(result.status,0,`PowerShell failed: ${result.stderr}; ${result.error}`);return JSON.parse(result.stdout);}
function readRules(names){return ps(`Import-Module NetSecurity -ErrorAction Stop; $names=@(ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())); $result=@(Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction Stop | Where-Object { $_.Name -in $names } | ForEach-Object { [pscustomobject]@{name=$_.Name;enabled=$_.Enabled.ToString();direction=$_.Direction.ToString();action=$_.Action.ToString();program=($_ | Get-NetFirewallApplicationFilter).Program;remoteAddress=($_ | Get-NetFirewallAddressFilter).RemoteAddress} }); ConvertTo-Json -InputObject $result -Depth 6 -Compress`,names);}
function processIdentity(pid){assert(Number.isSafeInteger(pid)&&pid>0);return ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if(!$p) {throw 'Browser process missing'}; [pscustomobject]@{pid=$p.ProcessId;started=$p.CreationDate.ToUniversalTime().ToString('o');argv=$p.CommandLine;executable=$p.ExecutablePath} | ConvertTo-Json -Compress`);}
function alive(pid){try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}
async function listen(server){await new Promise((ok,bad)=>{server.once('error',bad);server.listen(0,'127.0.0.1',ok);});}
async function deniedTcp(host){return await new Promise((ok,bad)=>{const socket=connect({host,port:80});socket.setTimeout(3000,()=>{socket.destroy();bad(Error('Timeout is not OS policy proof'));});socket.once('connect',()=>{socket.destroy();bad(Error('External TCP unexpectedly connected'));});socket.once('error',error=>{try{assert(['EACCES','EPERM'].includes(error.code),'Actual OS permission denial required');ok({host,port:80,error:error.code});}catch(cause){bad(cause);}});});}
function graphicsCapability(){const gl=document.querySelector('canvas').getContext('webgl2'),result={supported:!!gl};if(gl){const debug=gl.getExtension('WEBGL_debug_renderer_info');Object.assign(result,{lost:gl.isContextLost(),version:gl.getParameter(gl.VERSION),vendor:gl.getParameter(gl.VENDOR),renderer:gl.getParameter(gl.RENDERER)});if(debug)result.unmaskedRenderer=gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);gl.clearColor(0.25,0.5,0.75,1);gl.clear(gl.COLOR_BUFFER_BIT);const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);result.pixel=Array.from(pixel);result.error=gl.getError();}document.querySelector('#result').textContent=JSON.stringify(result,null,2);return result;}
