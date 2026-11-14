import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';

const powershell = script => execFileSync(join(process.env.ProgramFiles,'PowerShell/7/pwsh.exe'),['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop'; ${script}`],{encoding:'utf8'}).trim();
const quote = text => `'${text.replaceAll("'","''")}'`;
export async function consumerEnvironment(env, out) {
  const path=join(out,'no-developer-tools');await mkdir(path);
  const clean={...env};
  for(const key of Object.keys(clean))if(/^(path|node_options|node_path|pythonpath|pythonhome|cargo_home|rustup_home)$/i.test(key))delete clean[key];
  clean.PATH=path;
  return clean;
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
