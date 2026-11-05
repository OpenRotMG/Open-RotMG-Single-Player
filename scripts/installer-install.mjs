import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdir,cp,readdir,lstat,chmod,rm,rename,open,writeFile,stat} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';

export function installedPaths(root,version,platform=process.platform){
 const app=platform==='darwin'?join(root,'Open RotMG Single Player.app'):platform==='win32'?join(root,`app-${version}`):root;
 return {app,resources:join(app,platform==='darwin'?'Contents/Resources':'resources'),executable:join(app,platform==='darwin'?'Contents/MacOS/openrotmg-single-player':platform==='win32'?'openrotmg-single-player.exe':'openrotmg-single-player')};
}
export async function writableOwnedInstallation(root){
 if(process.platform==='win32')return;
 async function visit(path){const info=await lstat(path);if(info.isSymbolicLink())return;await chmod(path,info.mode|0o200);if(info.isDirectory())for(const name of await readdir(path))await visit(join(path,name));}
 await visit(root);
}
export function windowsMsiPlan(artifact,root,out,reinstall=false){
 const quoted=value=>{assert(typeof value==='string'&&value.length&&!/["\r\n\0]/.test(value)&&!value.endsWith('\\'),'MSI paths must be nonempty and have no quotes, control delimiters or trailing backslash');return `"${value}"`;};
 const operation=reinstall?'reinstall':'install',paths={verbose:join(out,operation+'.log'),stdout:join(out,operation+'-stdout.log'),stderr:join(out,operation+'-stderr.log'),diagnostic:join(out,'msi-'+operation+'.json')};
 // MSI documents PROPERTY="value with spaces"; libuv's default whole-argument quoting is different.
 const args=[reinstall?'/fa':'/i',quoted(artifact),'/qn','/norestart','MSIINSTALLPERUSER=1',`APPLICATIONROOTDIRECTORY=${quoted(root)}`,'/L*V!',quoted(paths.verbose)];
 return {file:'msiexec.exe',args,commandLine:'msiexec.exe '+args.join(' '),options:{cwd:out,timeout:300000,shell:false,windowsVerbatimArguments:true},paths};
}
export async function installWindowsMsi(artifact,root,out,reinstall=false,run=spawnSync){
 const plan=windowsMsiPlan(artifact,root,out,reinstall),diagnostic={format:1,operation:reinstall?'reinstall':'install',plan,startedAt:new Date().toISOString(),outcome:'running; installation state unverified',ioErrors:[]};
 await writeFile(plan.paths.diagnostic,JSON.stringify(diagnostic,null,2)+'\n',{flag:'wx'});
 let stdout,stderr,result;
 try{
  stdout=await open(plan.paths.stdout,'wx');stderr=await open(plan.paths.stderr,'wx');
  // Regular files avoid waiting for pipe EOF held by an inherited installer/service handle.
  result=run(plan.file,plan.args,{...plan.options,stdio:['ignore',stdout.fd,stderr.fd]});
 }catch(error){result={error,status:error.status??null,signal:error.signal??null,pid:error.pid??null};}
 finally{for(const handle of [stderr,stdout])if(handle)try{await handle.close();}catch(error){diagnostic.ioErrors.push(String(error));}}
 diagnostic.finishedAt=new Date().toISOString();diagnostic.result={pid:result.pid??null,status:result.status??null,signal:result.signal??null,timedOut:result.error?.code==='ETIMEDOUT',error:result.error?{name:result.error.name,message:result.error.message,code:result.error.code??null}:null};
 diagnostic.logs={};
 for(const name of ['verbose','stdout','stderr']){const path=plan.paths[name];try{const info=await stat(path);diagnostic.logs[name]={path,status:'present',bytes:info.size};}catch(error){diagnostic.logs[name]={path,status:error.code==='ENOENT'?'absent':'unreadable'};if(error.code!=='ENOENT')diagnostic.ioErrors.push(String(error));}}
 const success=!result.error&&result.status===0&&result.signal===null&&diagnostic.ioErrors.length===0;
 diagnostic.outcome=success?'child completed with exit 0; installed app not yet verified':diagnostic.result.timedOut?'timed out; partial installation state unknown; no retry or cleanup':'failed; partial installation state unknown; no retry or cleanup';
 try{await writeFile(plan.paths.diagnostic,JSON.stringify(diagnostic,null,2)+'\n');}catch(error){throw new Error('MSI diagnostics could not be persisted: '+JSON.stringify(diagnostic),{cause:error});}
 if(!success){const error=new Error(`MSI ${diagnostic.outcome}; status=${diagnostic.result.status}, signal=${diagnostic.result.signal}, code=${diagnostic.result.error?.code}; diagnostics: ${plan.paths.diagnostic}; verbose log: ${diagnostic.logs.verbose.status} (${plan.paths.verbose})`);error.installerInvocation=diagnostic;throw error;}
 return diagnostic;
}
export async function installArtifact(artifact,root,out,reinstall=false){
 const inside=relative(out,root);assert(inside&&!inside.startsWith('..')&&!isAbsolute(inside),'Installation must stay in this run-owned directory');
 if(process.platform==='win32'){
  assert(artifact.endsWith('.msi'));assert.equal(process.env.GITHUB_ACTIONS,'true','MSI install is restricted to an owned hosted Windows VM');
  const msi=await installWindowsMsi(artifact,root,out,reinstall);
  return {kind:'native per-user MSI install/repair',path:root,reinstall,msi};
 }else if(process.platform==='darwin'){
  assert(artifact.endsWith('.dmg'));const mount=join(out,'mounted image');await mkdir(mount,{recursive:true});
  execFileSync('hdiutil',['attach',artifact,'-readonly','-nobrowse','-mountpoint',mount],{timeout:60000});
  try{if(reinstall)await rm(root,{recursive:true});await mkdir(root,{recursive:true});await cp(join(mount,'Open RotMG Single Player.app'),join(root,'Open RotMG Single Player.app'),{recursive:true,verbatimSymlinks:true});}
  finally{execFileSync('hdiutil',['detach',mount],{timeout:60000});}
 }else{
  assert.equal(process.platform,'linux');assert(artifact.endsWith('.zip'));
  const extracted=join(out,reinstall?'reinstalled archive':'extracted archive');await mkdir(extracted);
  execFileSync('unzip',['-q',artifact,'-d',extracted],{timeout:120000});
  const directory='Open RotMG Single Player-linux-x64';assert.deepEqual(await readdir(extracted),[directory],'Expected exact Forge Linux package root');
  if(reinstall)await rm(root,{recursive:true});await rename(join(extracted,directory),root);
 }
 return {kind:process.platform==='win32'?'native per-user MSI install/repair':process.platform==='darwin'?'read-only DMG mount and application copy':'Forge ZIP extraction',path:root,reinstall};
}
