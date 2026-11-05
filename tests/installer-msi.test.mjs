import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile,stat} from 'node:fs/promises';
import {readFileSync,fstatSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {windowsMsiPlan,installWindowsMsi} from '../scripts/installer-install.mjs';

async function owned(){await mkdir('.qa/unit',{recursive:true});const out=await mkdtemp(resolve('.qa/unit/msi-'));return {out,artifact:join(out,'candidate é 日本.msi'),root:join(out,'installed é 日本')};}
const saved=async out=>JSON.parse(await readFile(join(out,'msi-install.json'),'utf8'));
function checkInvocation(file,args,options,out){
 assert.equal(file,'msiexec.exe');assert.equal(options.timeout,300000);assert.equal(options.shell,false);assert.equal(options.windowsVerbatimArguments,true);assert.equal(options.stdio[0],'ignore');
 assert(fstatSync(options.stdio[1]).isFile());assert(fstatSync(options.stdio[2]).isFile());assert.equal(JSON.parse(readFileSync(join(out,'msi-install.json'),'utf8')).outcome,'running; installation state unverified');
 assert(args.includes('/qn'));assert(args.includes('/norestart'));assert(args.includes('MSIINSTALLPERUSER=1'));
}

test('Windows MSI plan uses documented value quotes verbatim, same per-user install/repair and unchanged deadline without a shell',()=>{
 const artifact='D:\\owned qa\\candidate é 日本.msi',root='D:\\owned qa\\installed é 日本',out='D:\\owned qa';
 for(const reinstall of [false,true]){
  const plan=windowsMsiPlan(artifact,root,out,reinstall);assert.deepEqual(plan.args,[reinstall?'/fa':'/i',`"${artifact}"`,'/qn','/norestart','MSIINSTALLPERUSER=1',`APPLICATIONROOTDIRECTORY="${root}"`,'/L*V!',`"${plan.paths.verbose}"`]);
  assert.equal(plan.options.timeout,300000);assert.equal(plan.options.windowsVerbatimArguments,true);assert.equal(plan.options.shell,false);assert.equal(plan.commandLine,'msiexec.exe '+plan.args.join(' '));assert.equal(plan.paths.diagnostic,join(out,reinstall?'msi-reinstall.json':'msi-install.json'));
 }
 for(const invalid of ['bad"path','bad\npath','bad\0path','bad\\'])assert.throws(()=>windowsMsiPlan(artifact,invalid,out),/MSI paths/);
});
test('Windows MSI helper retains exact plan, real controlled child completion, verbose/stdout/stderr on success (no MSI execution)',async()=>{
 const {artifact,root,out}=await owned(),plan=windowsMsiPlan(artifact,root,out);
 const result=await installWindowsMsi(artifact,root,out,false,(file,args,options)=>{
  checkInvocation(file,args,options,out);
  return spawnSync(process.execPath,['-e',`require('fs').writeFileSync(${JSON.stringify(plan.paths.verbose)},'controlled verbose');process.stdout.write('controlled stdout');process.stderr.write('controlled stderr');`],{...options,windowsVerbatimArguments:false});
 });
 assert.equal(result.result.status,0);assert.equal(result.result.signal,null);assert.equal(result.result.timedOut,false);assert(result.result.pid>0);assert.match(result.outcome,/not yet verified/);assert.deepEqual(await saved(out),result);
 for(const [name,value] of [['verbose','controlled verbose'],['stdout','controlled stdout'],['stderr','controlled stderr']]){assert.equal(result.logs[name].status,'present');assert.equal(await readFile(result.logs[name].path,'utf8'),value);}
});
test('Windows MSI helper retains real controlled nonzero exit and native spawn error, with explicit missing verbose log (no MSI execution)',async()=>{
 for(const kind of ['exit','spawn']){
  const {artifact,root,out}=await owned();let native;
  await assert.rejects(installWindowsMsi(artifact,root,out,false,(file,args,options)=>{
   checkInvocation(file,args,options,out);
   native=kind==='exit'?spawnSync(process.execPath,['-e',"process.stdout.write('failure stdout');process.stderr.write('failure stderr');process.exit(7)"],{...options,windowsVerbatimArguments:false}):spawnSync(join(out,'nonexistent-owned-executable'),[],options);return native;
  }),error=>{assert.equal(error.installerInvocation.result.status,native.status);assert.equal(error.installerInvocation.result.signal,native.signal);assert.match(error.message,/partial installation state unknown/);return true;});
  const result=await saved(out);assert.equal(result.logs.verbose.status,'absent');assert.equal(result.logs.stdout.status,'present');assert.equal(result.logs.stderr.status,'present');
  if(kind==='exit'){assert.equal(result.result.status,7);assert.equal(await readFile(result.logs.stderr.path,'utf8'),'failure stderr');}else assert.equal(result.result.error.code,'ENOENT');
 }
});
test('Windows MSI helper records actual controlled native timeout without retry or cleaning unknown installation state',async()=>{
 const {artifact,root,out}=await owned();await mkdir(root);await writeFile(join(root,'partial-state'),'must preserve');let calls=0,native;
 const run=(file,args,options)=>{calls++;checkInvocation(file,args,options,out);native=spawnSync(process.execPath,['-e',"process.stdout.write('timeout stdout');process.stderr.write('timeout stderr');setInterval(()=>{},1000)"],{...options,windowsVerbatimArguments:false,timeout:500});return native;};
 await assert.rejects(installWindowsMsi(artifact,root,out,false,run),error=>{assert.equal(error.installerInvocation.result.timedOut,true);assert.equal(error.installerInvocation.result.status,native.status);assert.equal(error.installerInvocation.result.signal,native.signal);return true;});
 const result=await saved(out);assert.equal(calls,1);assert.equal(result.plan.options.timeout,300000);assert.equal(result.result.error.code,'ETIMEDOUT');assert.equal(result.logs.verbose.status,'absent');assert.equal(await readFile(join(root,'partial-state'),'utf8'),'must preserve');
 await assert.rejects(installWindowsMsi(artifact,root,out,false,run),/EEXIST/);assert.equal(calls,1);assert.deepEqual(await saved(out),result);
});
test('Windows MSI helper does not wait for inherited pipe EOF: controlled child exit completes while file-backed descendant waits',async()=>{
 const {artifact,root,out}=await owned(),release=join(out,'release-child'),done=join(out,'child-done');
 const descendant=`const fs=require('fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);process.stdout.write('descendant retained output');fs.writeFileSync(${JSON.stringify(done)},'done');}},20);setTimeout(()=>process.exit(1),5000).unref();`;
 // Detachment avoids the intermediate Node's Windows kill-on-close job; release/TTL still bounds this owned fixture.
 const descendantOptions={stdio:['ignore',1,2],windowsVerbatimArguments:false,detached:true,windowsHide:true};
 assert.equal(descendantOptions.detached,true);assert.equal(descendantOptions.windowsHide,true);assert.deepEqual(descendantOptions.stdio,['ignore',1,2]);
 const child=`require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],${JSON.stringify(descendantOptions)}).unref();`;
 try{
  const result=await installWindowsMsi(artifact,root,out,false,(file,args,options)=>{checkInvocation(file,args,options,out);return spawnSync(process.execPath,['-e',child],{...options,windowsVerbatimArguments:false,timeout:2000});});
  assert.equal(result.result.status,0);assert.equal(result.result.timedOut,false);await assert.rejects(stat(done),error=>error.code==='ENOENT');
 }finally{await writeFile(release,'release');const deadline=Date.now()+6000;while(!(await stat(done).catch(error=>{if(error.code==='ENOENT')return false;throw error;}))&&Date.now()<deadline)await delay(20);}
 assert.equal(await readFile(done,'utf8'),'done');assert.equal(await readFile(join(out,'install-stdout.log'),'utf8'),'descendant retained output');
});
test('Windows MSI structured failure and all root-owned diagnostic files are retained by existing result/workflow wiring',async()=>{
 const source=await readFile('scripts/verify-installer.mjs','utf8'),workflow=await readFile('.github/workflows/offline-installers.yml','utf8');assert(source.includes('report.installerInvocation=error.installerInvocation'));assert(workflow.includes('.qa/installer-tests/run-*/msi-*.json'));assert(workflow.includes('.qa/installer-tests/run-*/*.log'));
});
