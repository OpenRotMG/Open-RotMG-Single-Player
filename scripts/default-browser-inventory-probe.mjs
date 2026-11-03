import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {release} from 'node:os';
import {inventoryMode,inventoryPurpose,observe,completeInventory,persistInventory,nativeInventoryJSON} from './default-browser-inventory.mjs';
import {linuxObservation,proposedLinuxEnvironment} from './linux-default-browser-inventory.mjs';

const out=resolve('.qa/default-browser-inventory');
const report={purpose:inventoryPurpose,status:'initializing',head:process.env.GITHUB_SHA,platform:process.platform,arch:process.arch,osRelease:release(),startedAt:new Date().toISOString(),pathBoundary:{originalSystemPath:process.env.PATH??process.env.Path,consumerEnvironmentApplied:false,consumerPathDefinition:'Existing consumerEnvironment creates a dedicated empty no-developer-tools directory; NOT invoked or created by this inventory'},errors:[],notReady:[],acceptance:false,routingReadiness:'UNMEASURED; no browser execution or profile creation'};
let privateQuery=false;
try{
  privateQuery=inventoryMode(process.argv.slice(2),process.platform,process.env.GITHUB_ACTIONS);
  assert(process.arch==='x64'&&process.env.RUNNER_ENVIRONMENT==='github-hosted','Only standard GitHub-hosted x64 runners permitted');
  if(process.platform==='linux'){
    assert.match(await readFile('/etc/os-release','utf8'),/^VERSION_ID="22\.04"$/m,'Only fixed Ubuntu22 inventory permitted');
    assert.match(await readFile('/etc/os-release','utf8'),/^ID=ubuntu$/m);
    report.ordinary={errors:[],notReady:[]};await observe(report,'ordinaryCapture',async()=>{await linuxObservation(process.env,report.ordinary);return 'completed';});
    if(!privateQuery){
      const env=proposedLinuxEnvironment(process.env,out),helper=report.ordinary['helper:dbus-run-session'];
      report.privateEnvironment={display:'not created; DISPLAY and WAYLAND_DISPLAY unset',configHome:env.XDG_CONFIG_HOME,cacheHome:env.XDG_CACHE_HOME,profileDirectoriesCreated:false};
      if(helper?.actual){
        await observe(report,'privateSession',()=>nativeInventoryJSON(()=>execFileSync(helper.actual,[process.execPath,resolve('scripts/default-browser-inventory-probe.mjs'),'--private-query'],{env,encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024})));
        if(report.privateSession){report.privateSessionDifferent=report.ordinary.environment.DBUS_SESSION_BUS_ADDRESS.present? 'new dbus-run-session; ordinary address withheld':'new private bus versus no explicit ordinary bus';const other=report.privateSession.ordinary;report.associationComparison={ordinary:report.ordinary.httpDesktopId??null,private:other?.httpDesktopId??null,sameDesktopId:!!report.ordinary.httpDesktopId&&report.ordinary.httpDesktopId===other?.httpDesktopId,sameEntry:!!report.ordinary.desktop?.sha256&&report.ordinary.desktop.sha256===other?.desktop?.sha256,sameTarget:!!report.ordinary.target?.sha256&&report.ordinary.target.sha256===other?.target?.sha256&&report.ordinary.target.actual===other?.target?.actual};if(!report.associationComparison.sameDesktopId||!report.associationComparison.sameEntry||!report.associationComparison.sameTarget)report.notReady.push('Ordinary/private HTTP association does not have a proven identical resolution');}
      }else report.notReady.push('Private-session observer unavailable; no substitute session');
    }
    for(const nested of [report.ordinary,report.privateSession])if(nested){report.errors.push(...nested.errors);report.notReady.push(...nested.notReady);}
  }else{
    assert(release().startsWith('10.0.20348'),'Only fixed Windows2022 inventory permitted');
    report.environment={systemPath:process.env.PATH??process.env.Path,consumerPath:'Dedicated empty no-developer-tools directory in the existing package harness; not created here',localAppDataEnvironment:process.env.LOCALAPPDATA,userProfileEnvironment:process.env.USERPROFILE};
    const ps=join(process.env.ProgramFiles,'PowerShell/7/pwsh.exe'),script=await readFile('scripts/windows-default-browser-inventory.ps1','utf8');
    await observe(report,'windows',()=>nativeInventoryJSON(()=>execFileSync(ps,['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024})));
    if(report.windows){report.errors.push(...report.windows.errors);report.notReady.push(...report.windows.notReady);}
  }
}catch(error){await observe(report,'collector',()=>{throw error;});}
finally{
  // Private observer never creates output/profile directories; the parent retains its partial JSON.
  report.completedAt=new Date().toISOString();const code=completeInventory(report);
  if(privateQuery)process.stdout.write(JSON.stringify(report)+'\n');
  else {try{await persistInventory(join(out,'result.json'),report,async(path,bytes)=>{await mkdir(out,{recursive:true});await writeFile(path,bytes);});}catch(error){process.exitCode=1;throw error;}console.log(JSON.stringify({status:report.status,readiness:report.readiness,purpose:report.purpose,errors:report.errors,notReady:report.notReady}));process.exitCode=code;}
}
