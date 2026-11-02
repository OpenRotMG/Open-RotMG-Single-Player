import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, writeFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';

const powershell = script => execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop'; ${script}`],{encoding:'utf8'}).trim();
const quote = text => `'${text.replaceAll("'","''")}'`;
export async function consumerEnvironment(env, out) {
  const path=join(out,'no-developer-tools');await mkdir(path);
  const clean={...env};
  for(const key of Object.keys(clean))if(/^(path|node_options|node_path|pythonpath|pythonhome|cargo_home|rustup_home)$/i.test(key))delete clean[key];
  clean.PATH=path;
  return clean;
}
export async function protectInstallation(path) {
  if(process.platform==='win32') {
    assert(process.env.GITHUB_ACTIONS==='true','Windows ACL tests require a dedicated CI VM');
    const sid=powershell('[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
    execFileSync('icacls.exe',[path,'/deny',`*${sid}:(OI)(CI)(W,D)`,'/T','/Q']);
    return async()=>execFileSync('icacls.exe',[path,'/remove:d',`*${sid}`,'/T','/Q']);
  }
  const {chmod,lstat}=await import('node:fs/promises');
  const visit=async file=>{const info=await lstat(file);if(info.isSymbolicLink())return;if(info.isDirectory())for(const name of await readdir(file))await visit(join(file,name));await chmod(file,info.mode&~0o222);};
  await visit(path);
  return async()=>{};
}
export async function assertInstallationProtected(path, resources) {
  for(const directory of [path,resources])await assert.rejects(writeFile(join(directory,'forbidden-write'),'must not be writable'),error=>['EACCES','EPERM'].includes(error.code),'Real install write must be denied');
}
export function suspendServer(pid, suspend) {
  assert(Number.isSafeInteger(pid)&&pid>0,'Owned server PID required');
  if(process.platform!=='win32'){process.kill(pid,suspend?'SIGSTOP':'SIGCONT');return;}
  assert(process.env.GITHUB_ACTIONS==='true','Windows suspension requires an owned CI VM');
  powershell(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class NativeSuspend { [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h); [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h); }'; $p=Get-Process -Id ${pid}; $status=[NativeSuspend]::${suspend?'NtSuspendProcess':'NtResumeProcess'}($p.Handle); if($status -ne 0){throw "Native process suspension status=$status"}`);
}
export function runtimeLinkage(binary) {
  const run=(file,args)=>({command:[file,...args],output:execFileSync(file,args,{encoding:'utf8'}).trim()});
  if(process.platform==='linux') {
    const dependencies=run('ldd',[binary]);assert(!dependencies.output.includes('not found'),'Unresolved native library dependency');return {dependencies};
  }
  if(process.platform==='darwin') {
    const architecture=run('lipo',['-archs',binary]);assert.equal(architecture.output,process.arch==='arm64'?'arm64':'x86_64');
    const dependencies=run('otool',['-L',binary]);
    assert(!dependencies.output.split('\n').slice(1).some(line=>!/^\s+(\/usr\/lib\/|\/System\/Library\/)/.test(line)),'Server requires a non-system macOS library');
    return {architecture,dependencies};
  }
  assert(process.platform==='win32');
  const vswhere=join(process.env['ProgramFiles(x86)'],'Microsoft Visual Studio/Installer/vswhere.exe');
  const installation=run(vswhere,['-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-property','installationPath']).output;
  assert(installation,'Native compiler installation must identify its import inspector');
  const inspector=powershell(`(Get-ChildItem -Directory ${quote(join(installation,'VC/Tools/MSVC'))} | Sort-Object Name -Descending | Select-Object -First 1).FullName`);
  const dependencies=run(join(inspector,'bin/Hostx64/x64/dumpbin.exe'),['/DEPENDENTS',binary]);
  const imports=dependencies.output.match(/^\s+[\w.-]+\.dll\s*$/gim)?.map(line=>line.trim())??[];
  assert(imports.length,'PE imports must be observed');
  assert(!imports.some(name=>/^(vcruntime|msvcp|concrt)\d/i.test(name)),`Server depends on a developer-installed Visual C++ runtime; use a self-contained native build. Imports: ${imports.join(', ')}`);
  return {dependencies,imports};
}
