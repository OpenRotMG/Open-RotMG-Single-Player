import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {inventoryMode,desktopEntry,desktopWords,localMount,packageOwner,processEvidence,profileOverride,requireRootImage,observe,completeInventory,persistInventory,nativeInventoryJSON} from '../scripts/default-browser-inventory.mjs';
import {linuxEnvironment,proposedLinuxEnvironment,localInventoryPath} from '../scripts/linux-default-browser-inventory.mjs';

test('default-browser-inventory refuses caller-selected or nonnative scope',()=>{
  assert.equal(inventoryMode([],'win32','true'),false);assert.equal(inventoryMode(['--private-query'],'linux','true'),true);
  for(const args of [['--browser=chrome'],['--private-query','extra']])assert.throws(()=>inventoryMode(args,'linux','true'));
  assert.throws(()=>inventoryMode(['--private-query'],'win32','true'));assert.throws(()=>inventoryMode([],'darwin','true'));assert.throws(()=>inventoryMode([],'linux','false'));
});
test('default-browser-inventory desktop parser preserves actual entry and rejects ambiguous execution',()=>{
  for(const eol of ['\n','\r\n']){
    const entry=desktopEntry(['[Desktop Entry]','Type=Application','Exec="/opt/browser path/chrome" %U','TryExec=/opt/browser','[Other]','Exec=evil'].join(eol));assert.equal(entry.Exec,'"/opt/browser path/chrome" %U');assert.deepEqual(desktopWords(entry.Exec),['/opt/browser path/chrome','%U']);
  }
  for(const text of ['[Desktop Entry]\nType=Link\nExec=chrome','[Desktop Entry]\nType=Application\nExec=a\nExec=b','[Desktop Entry]\nType=Application\nHidden=true\nExec=a'])assert.throws(()=>desktopEntry(text));
  for(const text of ['env BROWSER=x chrome','chrome; evil','"unterminated','chrome $TOKEN','chrome --url=%U','chrome \\x'])assert.throws(()=>desktopWords(text));
});
test('default-browser-inventory permits only local filesystem path inspection',()=>{
  const mounts='1 0 0:1 / / rw - ext4 /dev/sda rw\n2 1 0:2 / /remote rw - nfs server:/dir rw\n3 1 0:3 / /odd rw - unknown none rw';
  assert.equal(localMount('/usr/bin/chrome',mounts).type,'ext4');for(const path of ['/remote/profile','/odd/file','relative'])assert.throws(()=>localMount(path,mounts));
});
test('default-browser-inventory dangling/remote links and inspection errors never prove an absent namespace',async()=>{
  const mounts='1 0 0:1 / / rw - ext4 /dev/sda rw\n2 1 0:2 / /remote rw - nfs server:/dir rw';
  const missing=()=>Object.assign(Error('missing'),{code:'ENOENT'});
  await assert.rejects(localInventoryPath('/link',mounts,{lstat:async path=>{if(path==='/link')return {isSymbolicLink:()=>true};throw missing();},readlink:async()=>'/absent'}),/Dangling link/);
  let remoteRead=false;await assert.rejects(localInventoryPath('/link',mounts,{lstat:async path=>{if(path.startsWith('/remote'))remoteRead=true;return {isSymbolicLink:()=>true};},readlink:async()=>'/remote/profile'}),/Nonlocal/);assert.equal(remoteRead,false);
  const denied=Object.assign(Error('actual EACCES'),{code:'EACCES'});await assert.rejects(localInventoryPath('/namespace',mounts,{lstat:async()=>{throw denied;},readlink:async()=>assert.fail()}),error=>error===denied);
  await assert.rejects(localInventoryPath('/loop',mounts,{lstat:async()=>({isSymbolicLink:()=>true}),readlink:async()=>'/loop'}),/Too many path links/);
});
test('default-browser-inventory image/package ownership is explicit and not guessed',()=>{
  const image={isFile:()=>true,uid:0,mode:0o100755};requireRootImage(image);
  for(const patch of [{uid:1000},{mode:0o100777},{mode:0o100644},{isFile:()=>false}])assert.throws(()=>requireRootImage({...image,...patch}));
  assert.equal(packageOwner('browser:amd64: /usr/bin/browser','/usr/bin/browser'),'browser:amd64');
  for(const text of ['other: /wrong','a: /usr/bin/browser\nb: /usr/bin/browser','/evil: /usr/bin/browser'])assert.throws(()=>packageOwner(text,'/usr/bin/browser'));
});
test('default-browser-inventory process evidence excludes full argv and URLs/secrets',()=>{
  const result=processEvidence({pid:42,birth:{bootId:'boot',startTicks:'123'},image:'/opt/chrome',words:['chrome','--password=secret','https://secret.invalid/token','--user-data-dir=/owned']});
  assert.deepEqual(result,{pid:42,birth:{bootId:'boot',startTicks:'123'},image:'/opt/chrome',profileOverride:'/owned'});assert(!JSON.stringify(result).includes('secret'));
  for(const words of [['--user-data-dir'],['--user-data-dir='],['--user-data-dir=/a','--user-data-dir=/b'],['--user-data-dir=https://secret.invalid/token']])assert.throws(()=>profileOverride(words));
  assert.equal(profileOverride(['--user-data-dir=C:\\owned']), 'C:\\owned');
  assert.throws(()=>processEvidence({pid:0,birth:'x',image:'x',words:[]}));assert.throws(()=>processEvidence({pid:1,birth:{bootId:'boot'},image:'x',words:[]}));
});
test('default-browser-inventory environment comparison does not set browser/default or reveal unrelated secrets',()=>{
  const env={HOME:'/home/runner',PATH:'/usr/bin',BROWSER:'secret-command',DBUS_SESSION_BUS_ADDRESS:'unix:path=/bus',SECRET:'not-for-report',DISPLAY:':0',WAYLAND_DISPLAY:'wayland-0'};
  const before={...env},privateEnv=proposedLinuxEnvironment(env,'/owned/report');assert.deepEqual(env,before);assert.equal(privateEnv.BROWSER,env.BROWSER);assert(!('DISPLAY' in privateEnv));assert(!('DBUS_SESSION_BUS_ADDRESS' in privateEnv));assert.equal(privateEnv.XDG_CONFIG_HOME,'/owned/report/private-config');
  const metadata=linuxEnvironment(env);assert(!JSON.stringify(metadata).includes('secret'));assert(!('SECRET' in metadata));assert.deepEqual(metadata.BROWSER,{present:true});
});
test('default-browser-inventory preserves partial/native errors and never normalizes unsupported into ready',async()=>{
  const report={errors:[],notReady:[],resolver:{executable:'measured'}};
  const error=Object.assign(Error('native failed'),{code:'EPERM',status:null,signal:'SIGTERM',stdout:'partial native evidence',stderr:'actual native diagnostic'});
  await observe(report,'target',()=>{throw error;});assert.equal(report.resolver.executable,'measured');assert.equal(report.errors[0].status,null);assert.equal(report.errors[0].signal,'SIGTERM');assert.equal(report.errors[0].partialOutput,'partial native evidence');assert.equal(report.errors[0].message,'actual native diagnostic');assert.equal(completeInventory(report),1);assert.equal(report.readiness,'not-ready');assert.equal(report.acceptance,false);
  const unsupported={errors:[],notReady:['delegated association']};assert.equal(completeInventory(unsupported),2);assert.equal(unsupported.status,'not-ready');assert.equal(unsupported.errors.length,0);
  const observed={errors:[],notReady:[]};assert.equal(completeInventory(observed),0);assert.equal(observed.acceptance,false);assert.match(observed.readiness,/PRECONDITIONS_ONLY/);
  let parseError;try{nativeInventoryJSON(()=>'{"partial":');}catch(error){parseError=error;}assert.equal(parseError.partialOutput,'{"partial":');
  for(const text of ['null','false','[]','{}','{"errors":[],"notReady":false}'])assert.throws(()=>nativeInventoryJSON(()=>text),/envelope is incomplete/);
  assert.deepEqual(nativeInventoryJSON(()=>'{"errors":[],"notReady":[]}'),{errors:[],notReady:[]});
});
test('default-browser-inventory receipt write failure preserves evidence and reports NOT PERSISTED without retry',async()=>{
  const report={status:'not-ready',errors:[{stage:'native',message:'primary'}],resolver:{partial:true}};let writes=0,text='';const io=Object.assign(Error('actual ENOSPC'),{code:'ENOSPC'});
  await assert.rejects(persistInventory('/owned/result.json',report,async()=>{writes++;throw io;},output=>text+=output),error=>error===io);assert.equal(writes,1);assert.equal(report.status,'failed');assert.equal(report.errors[0].message,'primary');assert.equal(report.errors[1].code,'ENOSPC');assert.match(text,/NOT PERSISTED/);assert.match(text,/"partial": true/);
  let saved;await persistInventory('/owned/result.json',{errors:[],status:'not-ready'},async(path,bytes)=>saved={path,bytes});assert.equal(saved.path,'/owned/result.json');assert.equal(JSON.parse(saved.bytes).status,'not-ready');
});
test('default-browser-inventory fixed workflow and observers never launch/alter a browser or network/default',async()=>{
  const workflow=await readFile('.github/workflows/default-browser-inventory.yml','utf8');assert.match(workflow,/workflow_dispatch:/);assert.match(workflow,/os: \[windows-2022, ubuntu-22\.04\]/);assert.match(workflow,/if: always\(\)/);assert(!/inputs:|npm |ci-inputs|package-test|playwright|sudo |self-hosted|macos|browser.*install/i.test(workflow));
  const ps=await readFile('scripts/windows-default-browser-inventory.ps1','utf8');assert.match(ps,/executable=\[DefaultBrowserNative\]::Query\(2\)/);assert.match(ps,/flags=0x1010/);assert.match(ps,/SHGetKnownFolderPath\(ref id,0x4000/);assert.match(ps,/finally \{ \$report \| ConvertTo-Json/);assert(!/Start-Process|Get-AuthenticodeSignature|Invoke-WebRequest|Set-Item|New-Item|Remove-Item|--version|Get-Content/.test(ps));
  const linux=await readFile('scripts/linux-default-browser-inventory.mjs','utf8');assert(!/--version|\.launch\(|fetch\(|https?:\/\//.test(linux));assert.match(linux,/xdg-mime'[^\n]*\['query','default','x-scheme-handler\/http'\]/);assert.match(linux,/ListNames only; no service activation/);
});
