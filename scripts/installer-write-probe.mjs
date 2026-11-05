import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {windowsPowerShellExecutable} from './native-boundaries.mjs';

export function requireWindowsInstallerWriteDenied(value,request){
 assert.equal(value.status,'complete');assert.equal(value.transport.inputCodePage,65001);assert.equal(value.transport.outputCodePage,65001);assert.equal(value.transport.inputRedirected,true);assert.equal(value.transport.outputRedirected,true);assert.equal(value.transport.requestUtf8Base64,Buffer.from(JSON.stringify(request),'utf8').toString('base64'));assert.deepEqual(value.transport.decodedDirectories,request.directories);
 assert(Array.isArray(value.directoryChecks));assert.equal(value.directoryChecks.length,2);
 for(const [index,check] of value.directoryChecks.entries()){assert.equal(check.directory,request.directories[index]);assert.equal(check.utf8Base64,Buffer.from(check.directory,'utf8').toString('base64'));assert.equal(check.provider.fullName,check.directory);assert.equal(check.provider.directory,true);assert.equal(check.provider.reparse,false);assert.equal(check.providerError,undefined);}
 assert.equal(request.directories.length,2);assert.equal(value.format,1);assert.equal(value.method,'FileStream(CreateNew,Write,None)');assert.equal(value.fileOptions,0);assert(typeof value.sid==='string'&&/^S-\d+(?:-\d+)+$/.test(value.sid));assert(Number.isSafeInteger(value.pid)&&value.pid>0);for(const version of [value.powerShell,value.dotnet])assert(typeof version==='string'&&version.length>0&&version.length<=64);assert(Array.isArray(value.privileges)&&value.privileges.length<=2);assert.equal(new Set(value.privileges.map(row=>row.name)).size,value.privileges.length);
 for(const row of value.privileges){assert(['SeBackupPrivilege','SeRestorePrivilege'].includes(row.name));assert(typeof row.state==='string'&&row.state.length>0&&row.state.length<=128);}
 assert(Array.isArray(value.probes));assert.equal(value.probes.length,request.directories.length);
 for(const [index,probe] of value.probes.entries()){
  assert.equal(probe.directory,request.directories[index]);assert.equal(probe.path,join(probe.directory,request.probeName));assert(typeof probe.ownerSid==='string'&&/^S-\d+(?:-\d+)+$/.test(probe.ownerSid));assert(typeof probe.sddl==='string'&&probe.sddl.length>0&&probe.sddl.length<=8192);
  assert(Array.isArray(probe.explicitDenies));assert.equal(probe.explicitDenies.length,1);assert.deepEqual(probe.explicitDenies[0],{mask:0x10156,inherited:false,inheritance:3,propagation:0},'Existing exact mutation-only directory deny must remain intact');
  assert.equal(probe.outcome,'error','Real normal Windows write must be denied, not succeed');assert.equal(probe.stage,'open');assert.equal(probe.created,false);assert.equal(probe.writeCompleted,false);assert.equal(probe.existsAfter,false);
  assert.equal(probe.exceptionType,'System.UnauthorizedAccessException');assert.equal(probe.hresult,-2147024891);assert.equal(probe.nativeError,5);
 }
 return value;
}
export async function assertWindowsInstallerWriteDenied(root,resources,out,phase,engine=windowsPowerShellExecutable(),run=execFileSync){
 assert(['install','reinstall'].includes(phase));
 for(const [parent,child] of [[out,root],[root,resources]]){const inside=relative(parent,child);assert(isAbsolute(parent)&&isAbsolute(child)&&inside&&!inside.startsWith('..')&&!isAbsolute(inside),'Probe directories must be inside this owned installation');}
 const request={directories:[root,resources],probeName:'installer-write-probe-'+randomUUID()},args=['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./installer-write-probe.ps1',import.meta.url))],path=join(out,`windows-write-probe-${phase}.json`);
 const diagnostic={format:1,phase,scope:'Ordinary Windows FileStream CreateNew/Write FileOptions.None; NOT Node backup-semantics IO denial',request,command:[engine,...args],startedAt:new Date().toISOString(),status:'running'};
 await writeFile(path,JSON.stringify(diagnostic,null,2)+'\n',{flag:'wx'});
 let failure;
 try{
  const stdout=run(engine,args,{input:JSON.stringify(request),encoding:'utf8',timeout:30000,maxBuffer:64*1024,windowsHide:true,shell:false});assert.equal(typeof stdout,'string');assert(Buffer.byteLength(stdout)<=64*1024,'Probe output exceeds bound');diagnostic.stdout=stdout;
  diagnostic.result=JSON.parse(stdout);requireWindowsInstallerWriteDenied(diagnostic.result,request);diagnostic.status='passed';
 }catch(error){failure=error;diagnostic.status='failed';diagnostic.error={message:String(error.message??error),code:error.code??null,status:error.status??null,signal:error.signal??null};if(error.stdout!==undefined){diagnostic.stdout=String(error.stdout).slice(0,64*1024);try{diagnostic.result=JSON.parse(diagnostic.stdout);}catch(parseError){diagnostic.outputParseError=parseError.message;}}if(error.stderr!==undefined)diagnostic.stderr=String(error.stderr).slice(0,4096);}
 diagnostic.finishedAt=new Date().toISOString();await writeFile(path,JSON.stringify(diagnostic,null,2)+'\n');
 if(failure){const error=new Error(`Windows installed normal-write probe failed: ${failure.message}; evidence: ${path}`,{cause:failure});error.windowsWriteProbe=diagnostic;throw error;}
 return diagnostic;
}
