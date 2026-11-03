import assert from 'node:assert/strict';
import {execFile,spawnSync} from 'node:child_process';
import {mkdir,copyFile,cp,readFile,lstat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {join,dirname,resolve,win32} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {tree,sha256} from './assets.mjs';
import {windowsPowerShellExecutable} from './native-boundaries.mjs';
import {installedEdgeImage,edgeImageAt} from './windows-edge-image.mjs';
import {openNativeOwnedEdge,assertNativeEdgeEnvironment} from './native-edge.mjs';
import {requireMicrosoftEdgePublisher,requireOwnedEdgeIdentity,requireOwnedEdgeInventory,classifyOwnedEdgeInstallerMetrics,ownedEdgeImageDifference,requireOwnedEdgeAfterRun} from './windows-owned-edge.mjs';
import {captureEdgeMetrics} from './windows-metrics-format.mjs';
import {cleanupWindowsOwnedRules,windowsOfflineCanaryResult,verifyWindowsOfflineCanary} from './windows-firewall-cleanup.mjs';

export const windowsOfflineRanges=['0.0.0.0-126.255.255.255','128.0.0.0-255.255.255.255','::/128','::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'];
const profileQuery="Get-NetFirewallProfile | Sort-Object Name | Select-Object Name,@{n='Enabled';e={$_.Enabled.ToString()}},@{n='DefaultInboundAction';e={$_.DefaultInboundAction.ToString()}},@{n='DefaultOutboundAction';e={$_.DefaultOutboundAction.ToString()}}";
const key=path=>win32.normalize(path).toLowerCase();
export function windowsPackagedOfflineMode(args,browser,platform,arch,github,extraArgs) {
  const selected=args.includes('--windows-offline');assert(selected===(browser==='ci-owned-edge'),'Select --windows-offline AND ci-owned-edge explicitly together');
  if(selected){assertNativeEdgeEnvironment(platform,arch,github,extraArgs);assert(!args.includes('--failure-tests-only')&&!args.includes('--check-port-only'),'Offline mode requires the complete unchanged packaged journey');}return selected;
}
export function assertOwnedWindowsProcess(identity,{program,pid,requestedAt,observedAt}) {
  assert.equal(identity.pid,pid);assert.equal(key(identity.executable),key(program),'Actual process must execute the owned policy image');const started=Date.parse(identity.started);assert(Number.isFinite(started)&&started>=requestedAt&&started<=observedAt,'Owned process generation must belong to this launch');
}
export function windowsOwnedRulePlans(node,edge,installed,group) {
  assert(installed===null||installed&&win32.isAbsolute(installed.directory),'Explicit diagnostic null or owned installation required');
  assert.equal(win32.basename(node).toLowerCase(),'owned-node.exe');assert.equal(key(edge),key(win32.join(win32.dirname(node),'owned-edge/msedge.exe')),'Edge target must be the fresh owned sibling image, never installed Edge');const programs=[['node',node],['edge',edge]];
  if(installed){assert.equal(key(installed.launcher),key(win32.join(installed.directory,'openrotmg-single-player.exe')));assert.equal(key(installed.server),key(win32.join(installed.directory,'resources/runtime/openrotmg.exe')));programs.push(['launcher',installed.launcher],['server',installed.server]);}
  assert(programs.every(([,program])=>win32.isAbsolute(program)),'Absolute owned programs required');assert.equal(new Set(programs.map(([,program])=>key(program))).size,programs.length);
  return programs.map(([role,program])=>({name:`${group}-${role}`,program}));
}
export function assertWindowsOfflineRules(actual,plans) {
  assert.equal(actual.length,plans.length,'Every exact component rule must remain present');
  const ranges=values=>values.map(value=>value==='::/128'?'::':value).sort();
  for(const plan of plans){const rule=actual.find(item=>item.name===plan.name);assert(rule&&rule.enabled==='True'&&rule.direction==='Outbound'&&rule.action==='Block'&&key(rule.program)===key(plan.program),`Exact owned program rule required: ${plan.name}`);assert.deepEqual(ranges(rule.remoteAddress),ranges(windowsOfflineRanges),'Exact nonloopback ranges required');}
}
export function createWindowsOwnedOffline({report,out,tmp,installed,env}) {
  assertNativeEdgeEnvironment(process.platform,process.arch,process.env.GITHUB_ACTIONS,JSON.parse(process.env.PI_NATIVE_TEST_CHROME_ARGS??'[]'));
  report.status='initializing';report.remoteAddresses=windowsOfflineRanges;report.errors=[];
  const fail=(stage,error)=>report.errors.push(`${stage}: ${error.stack??error}`);let prepared=false;
  return {
    get edgeImage(){assert(prepared,'Offline policy must be prepared before any owned browser');return report.ownedEdgeImage;},
    async prepare(){
      const source=await installedEdgeImage();requireMicrosoftEdgePublisher(source);report.installedEdgeSource=source;
      const directory=join(tmp,'owned-edge'),node=join(tmp,'owned-node.exe'),edge=join(directory,'msedge.exe');report.expectedBrowserExecutable=edge;assert.notEqual(key(source.executable),key(edge));
      report.ownedEdgeImage={sourceDirectory:dirname(source.executable),copyDirectory:directory,sourceImage:source,original:await tree(dirname(source.executable),[''])};const image=report.ownedEdgeImage;
      await copyFile(process.execPath,node);await cp(image.sourceDirectory,directory,{recursive:true,verbatimSymlinks:true});
      image.sourceMetadataBeforeRun=await edgeImageAt(source.executable);assert.deepEqual(image.sourceMetadataBeforeRun,source);image.copyMetadataBeforeRun=await edgeImageAt(edge);requireOwnedEdgeIdentity(source,image.copyMetadataBeforeRun);
      image.metricsBeforeRun=[];await captureEdgeMetrics(image.sourceDirectory,image.metricsBeforeRun);image.metricsCopySizesBeforeRun={};for(const file of image.metricsBeforeRun){const info=await lstat(join(directory,file.relativePath));assert(info.isFile()&&!info.isSymbolicLink());image.metricsCopySizesBeforeRun[file.relativePath]=info.size;}
      image.sourceAfterCopy=await tree(image.sourceDirectory,['']);image.copyBeforeRun=await tree(directory,['']);requireOwnedEdgeInventory(image.original,image.sourceAfterCopy,image.copyBeforeRun);image.prevalidatedInstallerMetrics=classifyOwnedEdgeInstallerMetrics(image);image.verifiedBeforeRun=true;
      const group='openrotmg-offline-'+randomUUID(),plans=windowsOwnedRulePlans(node,edge,installed,group);report.ruleGroup=group;report.rulePlans=plans;
      report.programs=[];for(const plan of plans){const program={...plan,copy:plan.program,sha256:sha256(await readFile(plan.program))};if(plan.program===node){program.source=process.execPath;assert.equal(program.sha256,sha256(await readFile(process.execPath)));}if(plan.program===edge){program.source=source.executable;assert.equal(program.sha256,source.sha256);}report.programs.push(program);}
      if(installed)report.installationBefore=await tree(installed.directory,['']);
      report.initialFirewall=ps(`Import-Module NetSecurity -ErrorAction Stop; [pscustomobject]@{engine=$PSVersionTable.PSVersion.ToString();module=(Get-Module NetSecurity).Path;administrator=([System.Security.Principal.WindowsPrincipal]::new([System.Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator);service=(Get-Service MpsSvc).Status.ToString();profiles=@(${profileQuery})} | ConvertTo-Json -Depth 5 -Compress`);
      assert.equal(report.initialFirewall.administrator,true);assert.equal(report.initialFirewall.service,'Running');assert(report.initialFirewall.profiles.some(profile=>profile.Enabled==='True'));report.preexistingRules=readRules(plans.map(plan=>plan.name));assert.deepEqual(report.preexistingRules,[]);
      report.ruleCleanupRegistered=plans.map(plan=>plan.name);
      ps(`Import-Module NetSecurity -ErrorAction Stop; $data=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()); foreach($plan in $data.plans) { New-NetFirewallRule -Name $plan.name -DisplayName $plan.name -Group $data.group -PolicyStore PersistentStore -Direction Outbound -Action Block -Enabled True -Profile Any -Protocol Any -Program $plan.program -RemoteAddress $data.ranges -ErrorAction Stop | Out-Null }; '{}'`,{plans,group,ranges:windowsOfflineRanges});
      report.actualRules=readRules(report.ruleCleanupRegistered);assertWindowsOfflineRules(report.actualRules,plans);
      report.nodeProcess=await new Promise(ok=>execFile(node,[resolve('scripts/windows-offline-probe.mjs'),'--node-policy-check'],{env,encoding:'utf8',timeout:15000,windowsHide:true},(error,stdout,stderr)=>ok(windowsOfflineCanaryResult(error,stdout,stderr))));report.nodeProof=verifyWindowsOfflineCanary(report.nodeProcess,node);
      await ownedBrowserCanary({report,out,tmp,env,image});prepared=true;report.status='prepared';
    },
    async finish(){
      // Same-image helpers can keep writing after the main browser or launcher closes.
      report.allOwnedImagesExited=false;
      if(report.ruleCleanupRegistered){try{report.allRulesBeforeCleanup=readRules(report.ruleCleanupRegistered);assertWindowsOfflineRules(report.allRulesBeforeCleanup,report.rulePlans);}catch(error){fail('Live final rules',error);}await cleanupWindowsOwnedRules(report,report.rulePlans,{observe:readRules,processes:ownedImageProcesses,remove:name=>ps(`Import-Module NetSecurity -ErrorAction Stop; $name=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()); try { Remove-NetFirewallRule -Name $name -PolicyStore PersistentStore -ErrorAction Stop; [pscustomobject]@{name=$name;removed=$true} | ConvertTo-Json -Compress } catch { [pscustomobject]@{name=$name;removed=$false;errorId=$_.FullyQualifiedErrorId;category=$_.CategoryInfo.Category.ToString();message=$_.Exception.Message} | ConvertTo-Json -Compress }`,name)});try{report.finalFirewallProfiles=ps(`Import-Module NetSecurity -ErrorAction Stop; @(${profileQuery}) | ConvertTo-Json -Depth 4 -Compress`);assert.deepEqual(report.finalFirewallProfiles,report.initialFirewall.profiles);}catch(error){fail('Global profile observation',error);}}
      report.finalSnapshotExitBoundaryProven=report.allOwnedImagesExited;
      for(const program of report.programs??[])try{assert.equal(sha256(await readFile(program.program)),program.sha256,`Policy program bytes changed: ${program.program}`);}catch(error){fail('Program integrity',error);}
      if(installed&&report.installationBefore)try{report.installationAfter=await tree(installed.directory,['']);assert.deepEqual(report.installationAfter,report.installationBefore,'Complete installed application resources changed');}catch(error){fail('Installation integrity',error);}
      const image=report.ownedEdgeImage;
      if(image){
        for(const [name,path]of [['sourceAfterRun',image.sourceDirectory],['copyAfterRun',image.copyDirectory]])try{image[name]=await tree(path,['']);}catch(error){fail(`${name} inventory`,error);}
        for(const [name,path]of [['sourceMetadataAfterRun',image.sourceImage.executable],['copyMetadataAfterRun',report.expectedBrowserExecutable]])try{image[name]=await edgeImageAt(path);}catch(error){fail(`${name} identity`,error);}
        if(image.copyAfterRun){image.afterRunDifference=ownedEdgeImageDifference(image.original,image.copyAfterRun);if(report.finalSnapshotExitBoundaryProven)image.wholeApplicationDirUnchanged=image.original.sha256===image.copyAfterRun.sha256&&Object.values(image.afterRunDifference).every(entries=>entries.length===0);}
        try{const integrity=requireOwnedEdgeAfterRun(image);assert.deepEqual(image.sourceMetadataAfterRun,image.sourceImage);requireOwnedEdgeIdentity(image.sourceImage,image.copyMetadataAfterRun);assert.deepEqual(image.copyMetadataAfterRun,image.copyMetadataBeforeRun);assert(report.finalSnapshotExitBoundaryProven,'All owned images must be proven exited before accepting final integrity');image.consumedInstallerMetrics=integrity.consumedInstallerMetrics;image.immutableRuntimeVerified=true;}catch(error){fail('Final Edge integrity',error);}
      }
      report.status=prepared&&report.finalSnapshotExitBoundaryProven&&report.errors.length===0?'verified':'failed';
    }
  };
}
async function ownedBrowserCanary({report,out,tmp,env,image}) {
  const server=createServer((_request,response)=>response.end('<h1>Offline WebGL2 diagnostic - not game acceptance</h1><pre id="result"></pre><canvas width="256" height="256"></canvas>'));let edge,failure;
  try{
    await new Promise((ok,bad)=>{server.once('error',bad);server.listen(0,'127.0.0.1',ok);});report.origin=`http://127.0.0.1:${server.address().port}`;report.profile=join(tmp,'policy-browser-profile');
    edge=await openNativeOwnedEdge({owner:'owned-policy-canary',profile:report.profile,env,report},image);report.browser=edge.record;await edge.page.goto(report.origin);report.browserLoopback=true;report.webgl2=await edge.page.evaluate(graphicsCapability);
    const network=await edge.context.newCDPSession(edge.page),requests=new Map();report.browserNetworkFailures=[];network.on('Network.requestWillBeSent',event=>requests.set(event.requestId,event.request.url));network.on('Network.loadingFailed',event=>{if(requests.get(event.requestId)==='http://1.1.1.1/')report.browserNetworkFailures.push({url:requests.get(event.requestId),errorText:event.errorText,blockedReason:event.blockedReason});});await network.send('Network.enable');
    report.browserExternalFetch=await edge.page.evaluate(async()=>{try{await fetch('http://1.1.1.1/',{mode:'no-cors',cache:'no-store',signal:AbortSignal.timeout(5000)});return {connected:true};}catch(error){return {error:String(error)};}});const deadline=Date.now()+3000;while(!report.browserNetworkFailures.length&&Date.now()<deadline)await delay(50);
    assert(!report.browserExternalFetch.connected&&report.browserNetworkFailures.some(event=>['net::ERR_NETWORK_ACCESS_DENIED','net::ERR_ACCESS_DENIED'].includes(event.errorText)),'Actual browser OS denial required');assert(report.webgl2.supported&&!report.webgl2.lost);assert.equal(report.webgl2.error,0);assert(report.webgl2.pixel.every((value,index)=>Math.abs(value-[64,128,191,255][index])<=1));await mkdir(out,{recursive:true});await edge.page.screenshot({path:join(out,'offline-webgl2.png')});
  }catch(error){failure=error;}
  if(edge)try{await edge.close();report.browserExited=edge.record.browserExited;}catch(error){failure=failure?new AggregateError([failure,error],`${failure}; Browser cleanup: ${error}`):error;}
  try{if(server.listening){server.closeAllConnections();await new Promise((ok,bad)=>server.close(error=>error?bad(error):ok()));}}catch(error){failure=failure?new AggregateError([failure,error],`${failure}; HTTP cleanup: ${error}`):error;}
  if(failure)throw failure;
}
function graphicsCapability(){const gl=document.querySelector('canvas').getContext('webgl2'),result={supported:!!gl};if(gl){const debug=gl.getExtension('WEBGL_debug_renderer_info');Object.assign(result,{lost:gl.isContextLost(),version:gl.getParameter(gl.VERSION),vendor:gl.getParameter(gl.VENDOR),renderer:gl.getParameter(gl.RENDERER)});if(debug)result.unmaskedRenderer=gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);gl.clearColor(0.25,0.5,0.75,1);gl.clear(gl.COLOR_BUFFER_BIT);const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);result.pixel=Array.from(pixel);result.error=gl.getError();}document.querySelector('#result').textContent=JSON.stringify(result,null,2);return result;}
function ps(script,input){const result=spawnSync(windowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop'; ${script}`],{encoding:'utf8',input:input===undefined?undefined:JSON.stringify(input),timeout:30000});assert.equal(result.status,0,`PowerShell failed: ${result.stderr}; ${result.error}`);return JSON.parse(result.stdout);}
function ownedImageProcesses(program){const result=ps(`$program=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()); $filter="ExecutablePath = '" + $program.Replace('\\','\\\\').Replace("'","\\'") + "'"; $items=@(Get-CimInstance Win32_Process -Filter $filter -ErrorAction Stop | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;started=$_.CreationDate.ToUniversalTime().ToString('o');executable=$_.ExecutablePath;argv=$_.CommandLine} }); ConvertTo-Json -InputObject $items -Depth 4 -Compress`,program);assert(Array.isArray(result));for(const identity of result){assert(Number.isSafeInteger(identity.pid)&&identity.pid>0&&Number.isFinite(Date.parse(identity.started))&&typeof identity.argv==='string'&&key(identity.executable)===key(program),'Owned-image process generation must be observed');}return result;}
function readRules(names){return ps(`Import-Module NetSecurity -ErrorAction Stop; $names=@(ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())); $result=@(Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction Stop | Where-Object { $_.Name -in $names } | ForEach-Object { [pscustomobject]@{name=$_.Name;enabled=$_.Enabled.ToString();direction=$_.Direction.ToString();action=$_.Action.ToString();program=($_ | Get-NetFirewallApplicationFilter).Program;remoteAddress=($_ | Get-NetFirewallAddressFilter).RemoteAddress} }); ConvertTo-Json -InputObject $result -Depth 6 -Compress`,names);}
