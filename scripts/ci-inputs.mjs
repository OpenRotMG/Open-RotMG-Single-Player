import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { sha256 } from './assets.mjs';

assert(process.env.GITHUB_ACTIONS==='true','This build adapter is only for owned native GitHub runners, not VPS builds');
const pins=JSON.parse(await readFile('source-pins.json','utf8'));
const root=resolve('.qa/ci-inputs');await mkdir(root,{recursive:true});
const run=(file,args,cwd)=>execFileSync(file,args,{cwd,stdio:'inherit'});
for(const name of ['server','client']) {
  const path=join(root,name);
  run('git',['-c','core.autocrlf=false','clone','--no-checkout',pins[name].repository,path]);
  run('git',['-C',path,'-c','core.autocrlf=false','checkout','--detach',pins[name].commit]);
}
const serverSource=join(root,'server'),clientSource=join(root,'client');
run('cargo',['build','--locked','--release'],serverSource);
run(process.platform==='win32'?'python':'python3',['scripts/run.py','--prepare-only'],clientSource);
const serverBinary=join(serverSource,'target/release',process.platform==='win32'?'openrotmg.exe':'openrotmg');
const serverBinarySha256=sha256(await readFile(serverBinary)),serverBuildReceipt=join(root,'server-artifact.json');
await writeFile(serverBuildReceipt,JSON.stringify({head:execFileSync('git',['rev-parse','HEAD'],{cwd:serverSource,encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:serverSource,encoding:'utf8'}).trim()!=='',sha256:serverBinarySha256,command:['cargo','build','--locked','--release'],rustc:execFileSync('rustc',['--version'],{cwd:serverSource,encoding:'utf8'}).trim()},null,2));
const inputs=join(root,'build-inputs.json');
await writeFile(inputs,JSON.stringify({serverSource,clientSource,preparedClient:clientSource,serverBinary,serverBinarySha256,serverBuildReceipt,platform:process.platform,arch:process.arch},null,2));
await writeFile(process.env.GITHUB_ENV,`OPENROTMG_BUILD_INPUTS=${inputs}\n`,{flag:'a'});
console.log(inputs);
