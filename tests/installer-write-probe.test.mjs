import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile} from 'node:fs/promises';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve,isAbsolute} from 'node:path';
import {execFileSync} from 'node:child_process';
import {windowsPowerShellExecutable} from '../scripts/native-boundaries.mjs';
import {assertWindowsInstallerWriteDenied,requireWindowsInstallerWriteDenied} from '../scripts/installer-write-probe.mjs';

const request={directories:['/owned installed é','/owned installed é/runtime'],probeName:'installer-write-probe-00000000-0000-0000-0000-000000000000'};
function denied(input=request){return {status:'complete',transport:{inputCodePage:65001,outputCodePage:65001,inputRedirected:true,outputRedirected:true,requestUtf8Base64:Buffer.from(JSON.stringify(input),'utf8').toString('base64'),decodedDirectories:[...input.directories]},directoryChecks:input.directories.map(directory=>({directory,utf8Base64:Buffer.from(directory,'utf8').toString('base64'),provider:{fullName:directory,directory:true,reparse:false}})),format:1,method:'FileStream(CreateNew,Write,None)',fileOptions:0,sid:'S-1-5-21-1234',pid:123,powerShell:'7.5.0',dotnet:'9.0.0',privileges:[{name:'SeBackupPrivilege',state:'Enabled'},{name:'SeRestorePrivilege',state:'Enabled'}],probes:input.directories.map(directory=>({directory,path:join(directory,input.probeName),ownerSid:'S-1-5-21-1234',sddl:'D:(D;OICI;0x10156;;;S-1-5-21-1234)',explicitDenies:[{mask:0x10156,inherited:false,inheritance:3,propagation:0}],stage:'open',created:false,writeCompleted:false,existsAfter:false,outcome:'error',exceptionType:'System.UnauthorizedAccessException',hresult:-2147024891,nativeError:5}))};}
async function owned(){await mkdir('.qa/unit',{recursive:true});const out=await mkdtemp(resolve('.qa/unit/installer-write-')),root=join(out,'installed é 日本'),runtime=join(root,'runtime');await mkdir(runtime,{recursive:true});return {out,root,runtime};}

test('installer normal Windows write denial requires exact native access-denied and unchanged mutation-only ACL; privileges are context, not a predicate',()=>{
 const value=denied();assert.equal(requireWindowsInstallerWriteDenied(value,request),value);value.privileges=[];assert.equal(requireWindowsInstallerWriteDenied(value,request),value);
});
test('installer write probe rejects successful writes, unexpected IO, backup semantics, malformed/badly scoped data and altered deny masks',()=>{
 const changes=[v=>v.status='failed',v=>v.transport.inputCodePage=1252,v=>v.transport.outputCodePage=1252,v=>v.transport.inputRedirected=false,v=>v.transport.requestUtf8Base64='changed',v=>v.transport.decodedDirectories[0]='/other',v=>v.directoryChecks.pop(),v=>v.directoryChecks[0].provider.directory=false,v=>v.directoryChecks[0].provider.reparse=true,v=>v.directoryChecks[0].providerError={message:'lookup failed'},v=>v.directoryChecks[0].utf8Base64='changed',v=>v.format=2,v=>v.fileOptions=0x02000000,v=>v.method='Node writeFile',v=>v.sid=[v.sid],v=>v.pid='123',v=>v.probes=[],v=>v.probes.pop(),v=>v.probes[0].directory='/other',v=>v.probes[0].path='/other',v=>v.probes[0].ownerSid=[v.sid],v=>v.probes[0].outcome='write-succeeded',v=>v.probes[0].stage='write',v=>v.probes[0].created=true,v=>v.probes[0].writeCompleted=true,v=>v.probes[0].existsAfter=true,v=>v.probes[0].exceptionType='System.IO.IOException',v=>v.probes[0].exceptionType='System.IO.DirectoryNotFoundException',v=>v.probes[0].hresult=-2147024893,v=>v.probes[0].hresult='-2147024891',v=>v.probes[0].nativeError=32,v=>v.probes[0].explicitDenies[0].mask|=0x100000,v=>v.probes[0].explicitDenies[0].mask='65878',v=>v.probes[0].explicitDenies[0].inherited=true,v=>v.probes[0].explicitDenies[0].inheritance=0,v=>v.probes[0].explicitDenies.push(v.probes[0].explicitDenies[0])];
 for(const change of changes){const value=denied();change(value);assert.throws(()=>requireWindowsInstallerWriteDenied(value,request));}
 for(const value of [null,{},false])assert.throws(()=>requireWindowsInstallerWriteDenied(value,request));
});
test('installer Windows-only probe saves exact owned request, SID/DACL/privilege/native-IO evidence for both phases (controlled PowerShell protocol)',async()=>{
 const {out,root,runtime}=await owned();
 for(const phase of ['install','reinstall']){
  let calls=0;
  const proof=await assertWindowsInstallerWriteDenied(root,runtime,out,phase,'owned-pwsh-not-executed',(engine,args,options)=>{
   calls++;assert.equal(engine,'owned-pwsh-not-executed');assert.deepEqual(args.slice(0,3),['-NoProfile','-NonInteractive','-File']);assert(isAbsolute(args[3]));assert(args[3].endsWith('installer-write-probe.ps1'));assert.equal(options.timeout,30000);assert.equal(options.maxBuffer,64*1024);
   const input=JSON.parse(options.input);assert.deepEqual(input.directories,[root,runtime]);assert.match(input.probeName,/^installer-write-probe-[a-f0-9-]{36}$/);assert.equal(JSON.parse(readFileSync(join(out,`windows-write-probe-${phase}.json`),'utf8')).status,'running');return JSON.stringify(denied(input));
  });
  assert.equal(calls,1);assert.equal(proof.status,'passed');assert(proof.scope.includes('NOT Node'));assert.deepEqual(JSON.parse(await readFile(join(out,`windows-write-probe-${phase}.json`),'utf8')),proof);assert.equal(proof.result.probes[0].explicitDenies[0].mask,0x10156);assert.equal(proof.result.privileges[0].state,'Enabled');
 }
});
test('installer probe never retries/falls back or cleans successful write evidence; bad output/spawn/timeout/unexpected IO fail with retained diagnostics',async()=>{
 for(const mode of ['success','bad-json','missing-fields','wrong-io','spawn','timeout']){
  const {out,root,runtime}=await owned();let calls=0,created;
  await assert.rejects(assertWindowsInstallerWriteDenied(root,runtime,out,'install','owned-pwsh-not-executed',(_engine,_args,options)=>{
   calls++;const input=JSON.parse(options.input),value=denied(input);
   if(mode==='success'){created=value.probes[0].path;writeFileSync(created,'unexpected controlled success');Object.assign(value.probes[0],{outcome:'write-succeeded',stage:'write',created:true,writeCompleted:true,existsAfter:true,exceptionType:null,hresult:null,nativeError:null});}
   if(mode==='bad-json')return 'not JSON';if(mode==='missing-fields')return '{}';if(mode==='wrong-io')value.probes[0].exceptionType='System.IO.IOException';
   if(mode==='spawn'||mode==='timeout')throw Object.assign(new Error('controlled native process error'),{code:mode==='spawn'?'ENOENT':'ETIMEDOUT',status:null,signal:mode==='timeout'?'SIGTERM':null,stdout:'controlled partial output',stderr:'controlled failure'});
   return JSON.stringify(value);
  }),error=>{assert.equal(error.windowsWriteProbe.status,'failed');return true;});
  assert.equal(calls,1);const evidence=JSON.parse(await readFile(join(out,'windows-write-probe-install.json'),'utf8'));assert.equal(evidence.status,'failed');assert(evidence.error.message);
  if(created)assert.equal(await readFile(created,'utf8'),'unexpected controlled success');
  if(mode==='spawn'||mode==='timeout'){assert.equal(evidence.stderr,'controlled failure');assert.equal(evidence.error.code,mode==='spawn'?'ENOENT':'ETIMEDOUT');}
 }
});
const parserEngine=process.platform==='win32'?windowsPowerShellExecutable():process.env.OPENROTMG_TEST_POWERSHELL;
test('installer write-probe PowerShell parses without executing any probe',{skip:!parserEngine?'Explicit PowerShell engine unavailable; no parser/runtime proof claimed':false},()=>{
 const script="$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile([Console]::In.ReadToEnd(),[ref]$tokens,[ref]$errors); if($errors.Count) { throw ($errors | Out-String) }; 'parsed'";
 assert.equal(execFileSync(parserEngine,['-NoProfile','-NonInteractive','-Command',script],{input:resolve('scripts/installer-write-probe.ps1'),encoding:'utf8',timeout:30000}).trim(),'parsed');
});
test('installer plain native script performs real FileStream write without backup semantics or token/ACL mutation; shared gate remains POSIX-only in installer',async()=>{
 const script=await readFile('scripts/installer-write-probe.ps1','utf8'),source=await readFile('scripts/verify-installer.mjs','utf8'),workflow=await readFile('.github/workflows/offline-installers.yml','utf8');
 assert(script.includes('[IO.FileStream]::new($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,1,[IO.FileOptions]::None)'));assert(script.includes('$stream.WriteByte(49)'));assert(script.includes('Get-Acl -LiteralPath'));assert(script.includes('System32/whoami.exe'));assert(script.includes('SeBackupPrivilege'));assert(script.includes('SeRestorePrivilege'));
 assert(!/Set-Acl|AdjustTokenPrivileges|SetTokenInformation|Remove-Item|FileOptions\]::Backup|Add-Type/.test(script));
 assert(source.includes("if(process.platform!=='win32')return assertInstallationProtected(installation,runtime)"));assert(source.includes("await assertProtected('install')"));assert(source.includes("await assertProtected('reinstall')"));assert(source.includes('report.windowsWriteProbes??=[]'));assert(workflow.includes('.qa/installer-tests/run-*/windows-write-probe-*.json'));
});
