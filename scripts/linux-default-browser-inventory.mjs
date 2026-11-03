import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {lstat,readlink,readFile,readdir,open} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {posix} from 'node:path';
const {resolve,join,dirname,basename,isAbsolute}=posix;
import {desktopEntry,desktopWords,localMount,packageOwner,processEvidence,profileOverride,observe,requireRootImage} from './default-browser-inventory.mjs';

const environmentKeys=['HOME','PATH','XDG_CONFIG_HOME','XDG_CONFIG_DIRS','XDG_DATA_HOME','XDG_DATA_DIRS','XDG_CACHE_HOME','XDG_RUNTIME_DIR','XDG_CURRENT_DESKTOP','DESKTOP_SESSION','KDE_SESSION_VERSION','DISPLAY','XAUTHORITY','WAYLAND_DISPLAY','CHROME_USER_DATA_DIR','CHROME_CONFIG_HOME'];
export function linuxEnvironment(env) {
  const values=Object.fromEntries(environmentKeys.filter(key=>key in env).map(key=>[key,env[key]]));
  for(const key of ['BROWSER','DEFAULTBROWSER','DBUS_SESSION_BUS_ADDRESS'])values[key]={present:!!env[key]};
  return values;
}
// Lexical parent removal can hide a symlink crossing before filesystem locality is checked.
function rejectParentComponents(path) {
  assert(typeof path==='string'&&!path.includes('\0')&&!path.split('/').includes('..'),'Parent path components are unsupported before normalization');
}
export function linuxInventoryRoots(env) {
  const roots=['HOME','XAUTHORITY','XDG_RUNTIME_DIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','CHROME_CONFIG_HOME','CHROME_USER_DATA_DIR'].map(key=>env[key]).filter(Boolean);
  for(const key of ['XDG_CONFIG_DIRS','XDG_DATA_DIRS'])if(env[key])roots.push(...env[key].split(':'));
  if(env.DBUS_SESSION_BUS_ADDRESS?.startsWith('unix:path=')){
    const path=env.DBUS_SESSION_BUS_ADDRESS.slice(10).split(',')[0];assert(!path.includes('%'),'Encoded session-bus paths are unsupported');roots.push(path);
  }
  for(const path of [...roots,...(env.PATH??'').split(':')])rejectParentComponents(path);
  return roots;
}
export function qualifyLinuxResolver(report) {
  report.resolverBoundary={kind:'fixed-observer',path:'/usr/bin:/bin',environment:'filtered whitelist',originalEnvironmentEquivalence:'UNPROVEN',desktopExecutableLookup:'original PATH; not proof of original resolver equivalence'};
  report.notReady.push('Original resolver environment equivalence is UNPROVEN; queries use fixed observer PATH and filtered environment');
}
export function proposedLinuxEnvironment(env,out) {
  linuxInventoryRoots(env);rejectParentComponents(out);
  const result={...env,XDG_CONFIG_HOME:join(out,'private-config'),XDG_CACHE_HOME:join(out,'private-cache')};
  delete result.DISPLAY;delete result.WAYLAND_DISPLAY;delete result.DBUS_SESSION_BUS_ADDRESS;return result;
}
const queryEnvironment=env=>Object.fromEntries(['HOME','XDG_CONFIG_HOME','XDG_CONFIG_DIRS','XDG_DATA_HOME','XDG_DATA_DIRS','XDG_CACHE_HOME','XDG_RUNTIME_DIR','XDG_CURRENT_DESKTOP','DESKTOP_SESSION','KDE_SESSION_VERSION','DISPLAY','XAUTHORITY','WAYLAND_DISPLAY','DBUS_SESSION_BUS_ADDRESS','LANG'].filter(key=>env[key]!==undefined).map(key=>[key,env[key]]).concat([['PATH','/usr/bin:/bin']]));
const command=(file,args,env)=>execFileSync(file,args,{encoding:'utf8',timeout:10000,maxBuffer:1024*1024,env:queryEnvironment(env)}).trim();
const hash=async(path,algorithm)=>{const result=createHash(algorithm);for await(const bytes of createReadStream(path))result.update(bytes);return result.digest('hex');};
export async function localInventoryPath(path,mounts,operations={lstat,readlink}) {
  const walk=async(path,links=0)=>{
    rejectParentComponents(path);assert(isAbsolute(path),'Absolute filesystem path required');let current='/';const parts=resolve(path).split('/').filter(Boolean);
    for(let i=0;i<parts.length;i++){
      current=join(current,parts[i]);localMount(current,mounts);const info=await operations.lstat(current);
      if(info.isSymbolicLink()){
        assert(++links<=16,'Too many path links');const rawTarget=await operations.readlink(current);rejectParentComponents(rawTarget);const target=resolve(dirname(current),rawTarget,...parts.slice(i+1));localMount(target,mounts);
        try{return await walk(target,links);}catch(error){if(error.code==='ENOENT')throw Error('Dangling link cannot prove namespace absence');throw error;}
      }
    }
    return current;
  };
  return walk(path);
}
// A rejected image needs raw attributes in the partial receipt to identify the failed predicate.
export function requireObservedLinuxImage(info,observation) {
  Object.assign(observation,{kind:info.isFile()?'regular-file':info.isDirectory()?'directory':info.isSymbolicLink()?'symlink':'other',uid:info.uid,gid:info.gid,mode:info.mode,permissions:info.mode&0o7777,dev:info.dev,ino:info.ino,size:info.size,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs});
  requireRootImage(info);
}
export async function linuxObservation(env,report) {
  report.environment=linuxEnvironment(env);report.observerPath='/usr/bin:/bin';report.profileContentsRead=false;qualifyLinuxResolver(report);
  const roots=linuxInventoryRoots(env),mounts=await readFile('/proc/self/mountinfo','utf8'),local=path=>localInventoryPath(path,mounts);
  const absent=async path=>{
    localMount(path,mounts);
    try {const actual=await local(path),info=await lstat(actual);return {path,exists:true,actual,uid:info.uid};}
    catch(error){if(error.code==='ENOENT')return {path,exists:false,observation:'ENOENT'};throw error;}
  };
  const image=async(path,observation={declaredPath:path})=>{
    const actual=await local(path);observation.resolvedPath=actual;const info=await lstat(actual);requireObservedLinuxImage(info,observation);
    for(let parent=dirname(actual);;parent=dirname(parent)){const stat=await lstat(parent);assert(stat.uid===0&&!(stat.mode&0o022),'Executable ancestor is not trusted');if(parent==='/')break;}
    const owner=packageOwner(command('/usr/bin/dpkg-query',['-S',actual],env),actual),version=command('/usr/bin/dpkg-query',['-W','-f=${binary:Package}\t${Version}\t${Architecture}',owner],env);
    const sumsPath=await local(`/var/lib/dpkg/info/${owner}.md5sums`),sums=await readFile(sumsPath,'utf8'),entry=sums.split('\n').filter(line=>line.slice(34)===actual.slice(1));assert.equal(entry.length,1,'Resolved file must have one installed package digest');
    assert.equal(await hash(actual,'md5'),entry[0].slice(0,32),'Installed package digest mismatch');
    const handle=await open(actual,'r');let prefix;try{const bytes=Buffer.alloc(4);await handle.read(bytes,0,4,0);prefix=bytes.toString('hex');}finally{await handle.close();}
    const sha256=await hash(actual,'sha256'),after=await lstat(actual);for(const key of ['dev','ino','size','mtimeMs','ctimeMs'])assert.equal(after[key],info[key],'Image changed during metadata/hash observations');assert.equal(await local(path),actual,'Executable resolution changed during observation');
    return {path,actual,uid:info.uid,mode:info.mode&0o777,package:owner,packageVersion:version,packageDigestMatched:true,sha256,kind:prefix==='7f454c46'?'ELF':'wrapper-or-unknown',trustBasis:'root-owned installed package file + package MD5 match + observed SHA256; NOT cryptographic package-signature verification'};
  };
  for(const path of roots)await absent(path);
  const helperPaths={};
  for(const name of ['xdg-mime','xdg-open','gio','dbus-run-session','dbus-send']){
    const metadata=await observe(report,`helper:${name}`,async()=>{const path=`/usr/bin/${name}`,state=await absent(path);return state.exists?await image(path):state;});
    if(metadata?.actual)helperPaths[name]=metadata.actual;
    if(!metadata?.actual)report.notReady.push(`Missing/unverified helper ${name}`);
  }
  if(env.DISPLAY)assert(/^:[0-9]+(?:\.[0-9]+)?$/.test(env.DISPLAY),'Nonlocal/unsupported DISPLAY; no desktop query attempted');
  if(env.BROWSER||env.DEFAULTBROWSER)report.notReady.push('Browser-selection environment override is present; value withheld');
  const bus=env.DBUS_SESSION_BUS_ADDRESS;
  if(bus){
    if(!/^unix:(?:path|abstract)=[^;]+$/.test(bus)){report.notReady.push('Nonlocal/unsupported session bus address; no bus connection attempted');return;}
    if(bus.startsWith('unix:path='))await local(bus.slice(10).split(',')[0]);
    if(helperPaths['dbus-send'])await observe(report,'portal',()=>({registered:command('/usr/bin/dbus-send',['--session','--reply-timeout=3000','--print-reply','--dest=org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus.ListNames'],env).includes('"org.freedesktop.portal.Desktop"'),observation:'ListNames only; no service activation'}));
  } else {report.portal={observation:'No explicit session bus; not connected or autolaunched'};}
  if(!helperPaths['xdg-mime'])return;
  const id=await observe(report,'httpDesktopId',()=>command('/usr/bin/xdg-mime',['query','default','x-scheme-handler/http'],env));
  if(!id){report.notReady.push('No measured HTTP desktop association');return;}
  assert(/^[A-Za-z0-9_.+-]+\.desktop$/.test(id),'Unsupported/ambiguous HTTP desktop ID');
  assert(env.HOME&&isAbsolute(env.HOME),'Absolute HOME required');
  const dataHome=env.XDG_DATA_HOME||join(env.HOME,'.local/share'),dataDirs=env.XDG_DATA_DIRS?env.XDG_DATA_DIRS.split(':'):['/usr/local/share','/usr/share'];
  let desktop;
  for(const root of [dataHome,...dataDirs]){assert(isAbsolute(root),'Absolute desktop search directory required');const path=join(root,'applications',id),state=await absent(path);if(state.exists){desktop=state.actual;break;}}
  assert(desktop,'Associated flat desktop entry not found; nested desktop IDs are not guessed');
  const stat=await lstat(desktop);assert(stat.isFile()&&stat.size<=65536,'Bounded regular desktop entry required');
  const entry=desktopEntry(await readFile(desktop,'utf8'));report.desktop={path:desktop,sha256:await hash(desktop,'sha256'),...entry};
  if(entry.DBusActivatable==='true')report.notReady.push('DBus-activated desktop entry is not a direct executable resolution');
  const words=desktopWords(entry.Exec),find=async name=>{
    rejectParentComponents(name);if(isAbsolute(name))return local(name);assert(!name.includes('/'),'Relative desktop executable not supported');
    for(const dir of (env.PATH??'').split(':')){assert(isAbsolute(dir),'Ambiguous executable PATH');const path=join(dir,name),state=await absent(path);if(state.exists)return local(path);}
    throw Error('Desktop executable not found in original PATH');
  };
  if(entry.TryExec)report.tryExec=await image(await find(entry.TryExec));
  report.targetObservation={declaredPath:words[0]};
  report.target=await image(await find(words[0]),report.targetObservation);
  if(report.target.kind!=='ELF')report.notReady.push('Desktop target is a wrapper/unknown image; browser execution target is not inferred');
  const targetName=basename(report.target.path),packageName=report.target.package.split(':')[0];let profile;
  const config=env.XDG_CONFIG_HOME||join(env.HOME,'.config');
  if(packageName==='google-chrome-stable'&&/^(google-chrome(?:-stable)?|chrome)$/.test(targetName))profile=env.CHROME_USER_DATA_DIR||join(env.CHROME_CONFIG_HOME||config,'google-chrome');
  else if(packageName==='microsoft-edge-stable'&&/^(microsoft-edge(?:-stable)?|msedge)$/.test(targetName))profile=join(config,'microsoft-edge');
  else if(packageName==='firefox'&&targetName==='firefox'){profile=join(env.HOME,'.mozilla/firefox');report.notReady.push('Firefox is not supported by the existing Chromium/CDP ownership adapter');}
  else report.notReady.push('Unknown browser/package profile semantics');
  const override=profileOverride(words);
  if(override){report.associationProfileOverride=override;profile=override;report.notReady.push('Association supplies a profile override; requires separate ownership contract');}
  if(profile){assert(isAbsolute(profile),'Relative profile namespace is ambiguous');report.profileNamespace=await absent(profile);if(report.profileNamespace.exists)report.notReady.push('Existing profile namespace must not be adopted');}
  report.processInspection={scope:'all visible processes, exact resolved desktop executable',browserImageProven:report.target.kind==='ELF',unreadableImageCount:0};report.processes=[];const boot=await readFile('/proc/sys/kernel/random/boot_id','utf8');
  for(const pid of await readdir('/proc')){
    if(!/^[0-9]+$/.test(pid))continue;
    let matched=false;
    try{
      const root=`/proc/${pid}`,actual=await readlink(root+'/exe');if(actual!==report.target.actual)continue;matched=true;
      const record={pid:Number(pid),image:actual,inspection:'partial'};report.processes.push(record);
      const ticks=line=>line.slice(line.lastIndexOf(')')+2).split(' ')[19],before=await readFile(root+'/stat','utf8');record.birth={bootId:boot.trim(),startTicks:ticks(before)};
      const words=(await readFile(root+'/cmdline')).toString().split('\0').filter(Boolean),after=await readFile(root+'/stat','utf8');
      assert.equal(ticks(before),ticks(after),'Process generation changed during inspection');assert.equal(await readlink(root+'/exe'),actual,'Process image changed during inspection');
      Object.assign(record,processEvidence({pid:Number(pid),birth:{bootId:boot.trim(),startTicks:ticks(before)},image:actual,words}),{inspection:'complete'});
    }catch(error){if(matched)throw error;if(['EACCES','EPERM'].includes(error.code))report.processInspection.unreadableImageCount++;else if(!['ENOENT','ESRCH'].includes(error.code))throw error;}
  }
  if(report.processInspection.unreadableImageCount)report.notReady.push('Some process images could not be inspected; target absence is not proven');
  if(report.processes.length)report.notReady.push('Preexisting target-image processes; no adoption permitted');
  report.routingReadiness='UNMEASURED; no browser execution or profile creation';
}
