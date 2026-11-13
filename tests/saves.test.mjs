import test from 'node:test';
import assert from 'node:assert/strict';
import processes from 'node:child_process';
import fs, {mkdir,mkdtemp,writeFile,readFile,readdir,stat,chmod} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Runtime} from '../dist/runtime.js';
import {SaveControls,saveAuthority,checkedPassword,importPreview,snapshotPreview,isBackupName} from '../dist/saves.js';

// This executable tests transport/lifecycle only, never claims Rust save or packaged acceptance.
const executable=String.raw`#!${process.execPath}
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const [flag,command,...args]=process.argv.slice(2),control=JSON.parse(fs.readFileSync('control.json','utf8'));
if(flag!=='--local-save')process.exit(8);
const fail=(outcome,error)=>{console.log(JSON.stringify({protocol:1,operation:command,outcome,error,...control.failureEnvelope}));console.error('diagnostic only; never phase evidence');process.exitCode=2;};
fs.appendFileSync('calls.jsonl',JSON.stringify({command,args})+'\n');
const identity=()=>{const input=fs.readFileSync(args[2]);return {account:1,login:'player-1@local.invalid',replaced:!!control.replaced,disclosure:'Personal progress only.',exported_at:1700000000,name:input.toString(),character_count:3,expected:crypto.createHash('sha256').update(input).update(control.identity||'').digest('hex')};};
if(control.signal){process.kill(process.pid,'SIGTERM');}
else if(control.overflow){process.stdout.write('x'.repeat(70000));}
else if(control.invalid){console.log('not JSON');}
else if(control.noAck){process.exitCode=2;}
else if(control.invalidUtf8){process.stdout.write(Buffer.concat([Buffer.from('{"protocol":1,"operation":"'+command+'","outcome":"unchanged","error":"'),Buffer.from([255]),Buffer.from('"}') ]));process.exitCode=2;}
else if(control.fail){fail('unchanged','specific authority validation failure');}
else if(control.unknown){fail('unknown','destination write or migration boundary crossed');}
else if(command==='accounts'||command==='account-edit')console.log(JSON.stringify(control.accountResult));
else if(command==='preview')setTimeout(()=>console.log(JSON.stringify(identity())),control.delay||0);
else if(command==='verify-snapshot')console.log(JSON.stringify({verified:true,schema:22,scope:'all-local-accounts',account_count:2,character_count:7}));
else if(command==='snapshot'){fs.writeFileSync(args[2],'full fixture snapshot',{flag:'wx',mode:0o600});console.log(JSON.stringify({snapshot:args[2],verified:true}));}
else if(command==='import'||command==='replace'){
 let secret='';process.stdin.on('data',bytes=>secret+=bytes);process.stdin.on('end',()=>{
 const result=identity();if(result.expected!==args[4]){fail('unchanged','stale expectation; preview again');return;}
 fs.writeFileSync('imported.json',JSON.stringify({bytes:fs.readFileSync(args[2],'utf8'),secretLength:Buffer.byteLength(secret)}));console.log(JSON.stringify({account:result.account,login:result.login,replaced:result.replaced,disclosure:result.disclosure}));
 });
}else if(command==='restore'){fs.writeFileSync(args[3],'pre-restore');console.log(JSON.stringify({restored:true,backup:args[3]}));}
else process.exit(9);
`;
async function fixture(){
 await mkdir('.qa/unit',{recursive:true});const root=await mkdtemp(resolve('.qa/unit/saves-')),resources=join(root,'resources'),user=join(root,'user');await mkdir(resources);await mkdir(user);
 const control=async value=>writeFile(join(resources,'control.json'),JSON.stringify(value));await control({});
 await writeFile(join(resources,'openrotmg'),executable,{mode:0o700});
 const source=join(root,'selected.json');await writeFile(source,'Original account');
 const runtime=new Runtime(resources,user);let chosen=source,confirm=true,opened;
 const dialogs={choose:async()=>chosen,confirmRestore:async()=>confirm,openFolder:async path=>{opened=path;return '';}};
 const saves=new SaveControls(runtime,dialogs);
 return {runtime,saves,dialogs,resources,user,root,source,control,choose:value=>{chosen=value;},confirm:value=>{confirm=value;},opened:()=>opened};
}
const posix={skip:process.platform==='win32'};

test('save preview and snapshot metadata are required, not invented',()=>{
 assert.throws(()=>importPreview({account:1,login:'player-1@local.invalid',replaced:false,disclosure:'x'}),/metadata/);
 assert.throws(()=>snapshotPreview({verified:true}),/metadata/);
 for(const [value,confirmation] of [['short','other'],['abcd','abcd'],['12345\n','12345\n'],['é'.repeat(65),'é'.repeat(65)],['abc\ud800','abc\ud800']])assert.throws(()=>checkedPassword(value,confirmation),/password/);
 assert.equal(checkedPassword('é'.repeat(64),'é'.repeat(64)),'é'.repeat(64));
});
test('account authority returns known passwords only to its caller, never the durable lifecycle acknowledgement',posix,async()=>{
 const f=await fixture(),secret='private-local-credential',row={account:1,name:'Guest1',username:'player@local.invalid',password:secret,expected:'a'.repeat(64)};await f.control({accountResult:{accounts:[row]}});let proof;f.runtime.authorityClosed=async value=>{proof=value;};const value=await f.runtime.stoppedOperation('Read accounts',()=>saveAuthority(f.runtime,'accounts',['state','data']));assert.equal(value.accounts[0].password,secret);assert(!JSON.stringify(proof).includes(secret));assert.equal(proof.ack.accounts[0].username,row.username);
 await assert.rejects(f.saves.listAccounts(),/Server \+ client update/);assert.equal(f.runtime.view().status,'stopped');
});
test('save native chooser cancellation changes no save or backups',posix,async()=>{
 const f=await fixture();f.choose(undefined);assert.equal(await f.saves.beginImport(),undefined);assert.equal(await f.saves.restoreBackup(),undefined);
 assert.deepEqual(await readdir(f.user),[]);assert.equal(f.runtime.view().operation,undefined);
});
test('save privately staged input is bound through confirmation, passwords absent from argv and outcome',posix,async()=>{
 const f=await fixture();const preview=await f.saves.beginImport();assert.equal(preview.name,'Original account');
 await writeFile(f.source,'CHANGED EXTERNAL FILE');
 const outcome=await f.saves.finishImport(preview.expected,'secret-value','secret-value',false);
 assert.equal(outcome.login,preview.login);assert.deepEqual(JSON.parse(await readFile(join(f.resources,'imported.json'),'utf8')),{bytes:'Original account',secretLength:12});
 const calls=await readFile(join(f.resources,'calls.jsonl'),'utf8');assert(!calls.includes('secret-value'));assert(!JSON.stringify(outcome).includes('secret-value'));
 assert(!calls.includes(f.source),'only private stage path reaches authority');
 assert.deepEqual(await readdir(join(f.user,'save-staging')),[]);
});
test('save confirmation rejects changed token/password/replace arguments without consuming valid preview',posix,async()=>{
 const f=await fixture();const preview=await f.saves.beginImport();
 await assert.rejects(f.saves.finishImport('f'.repeat(64),'abcde','abcde',false),/does not match/);
 await assert.rejects(f.saves.finishImport(preview.expected,'abcde','wrong',false),/password/);
 await assert.rejects(f.saves.finishImport(preview.expected,'abcde','abcde',true),/does not match/);
 await f.saves.cancelImport();assert.deepEqual(await readdir(join(f.user,'save-staging')),[]);
 assert(!await readFile(join(f.resources,'calls.jsonl'),'utf8').then(x=>x.includes('"import"')));
});
test('save preview lifecycle reservation synchronously prevents Start/Stop/backup/restore/doubleclick races',posix,async()=>{
 const f=await fixture();const first=f.saves.beginImport();
 await assert.rejects(f.runtime.start(),/verified stopped/);await assert.rejects(f.runtime.stop(),/operation/);
 await assert.rejects(f.saves.makeBackup(),/operation/);await assert.rejects(f.saves.restoreBackup(),/operation/);await assert.rejects(f.saves.beginImport(),/operation/);
 await first;await f.saves.cancelImport();assert.equal(f.runtime.view().operation,undefined);
});
test('save external allocation change refuses stale preview and cleans staging without import',posix,async()=>{
 const f=await fixture();const preview=await f.saves.beginImport();await f.control({identity:'changed'});
 await assert.rejects(f.saves.finishImport(preview.expected,'abcde','abcde',false),/stale expectation; preview again/);
 await assert.rejects(readFile(join(f.resources,'imported.json')),/ENOENT/);assert.deepEqual(await readdir(join(f.user,'save-staging')),[]);
});
test('save full snapshots accumulate eight distinct private files without account export size cap',posix,async()=>{
 const f=await fixture(),paths=[];for(let i=0;i<8;i++){const result=await f.saves.makeBackup();paths.push(result.path);assert.equal(result.message,'Backup created.');}
 assert.equal(new Set(paths).size,8);assert.equal((await readdir(f.saves.backups)).length,8);
 for(const path of paths)assert.equal((await stat(path)).mode&0o077,0);
});
test('save restore cancel has no pre-backup; confirmation uses staged full snapshot and backup outcome',posix,async()=>{
 const f=await fixture();await writeFile(f.source,Buffer.alloc(33*1024*1024));f.confirm(false);assert.equal(await f.saves.restoreBackup(),undefined);await assert.rejects(readdir(f.saves.backups),/ENOENT/);
 f.confirm(true);const result=await f.saves.restoreBackup();assert.match(result.message,/original local logins and passwords/);assert.match(result.path,/pre-restore/);assert.equal(await readFile(result.path,'utf8'),'pre-restore');
});
test('save missing/malformed/oversize input and unwritable backups do not report success',posix,async()=>{
 const f=await fixture();f.choose(join(f.root,'missing'));await assert.rejects(f.saves.beginImport(),/ENOENT/);
 f.choose(f.source);await f.control({fail:true});await assert.rejects(f.saves.beginImport(),error=>/local save was not changed/.test(error.message)&&/specific authority validation failure/.test(error.cause.cause.message));
 await f.control({});await writeFile(f.source,Buffer.alloc(32*1024*1024+1));await assert.rejects(f.saves.beginImport(),/exceeds/);
 await chmod(f.user,0o500);try{await assert.rejects(f.saves.makeBackup(),/EACCES/);}finally{await chmod(f.user,0o700);}
 assert.equal(f.runtime.view().status,'stopped');assert.deepEqual(await readdir(join(f.user,'save-staging')),[]);
});
test('save Open backup folder awaits actual adapter and rejects OS returned error',posix,async()=>{
 const f=await fixture();const result=await f.saves.openBackupFolder();assert.equal(result.path,f.opened());
 f.dialogs.openFolder=async()=> 'No associated file manager';await assert.rejects(f.saves.openBackupFolder(),/No associated file manager/);
});
test('backup history lists regular snapshots newest first; named restore never accepts paths or symlinks',posix,async()=>{
 const f=await fixture(),first=await f.saves.makeBackup(),second=await f.saves.makeBackup();await fs.utimes(first.path,1,1);
 await writeFile(join(f.saves.backups,'not-a-snapshot.txt'),'ignored');await fs.symlink(first.path,join(f.saves.backups,'linked.sqlite'));
 const files=await f.saves.listBackups();assert.equal(files.length,2);assert.equal(files[0].name,second.path.split('/').at(-1));assert(files.every(file=>file.bytes>0&&file.modified>0));
 for(const name of ['../outside.sqlite','C:outside.sqlite','sub\\\\file.sqlite','x\u0000.sqlite','not-a-snapshot.txt']){assert(!isBackupName(name));await assert.rejects(f.saves.restoreBackup(name),/regular file/);}
 await assert.rejects(f.saves.restoreBackup('linked.sqlite'),/regular file/);f.confirm(true);const restored=await f.saves.restoreBackup(files[0].name);assert.match(restored.message,/original local logins and passwords/);
});
test('save location opener uses only the owned profile and propagates OS failures',posix,async()=>{
 const f=await fixture();const result=await f.saves.openSaveFolder();assert.equal(result.path,f.user);assert.equal(f.opened(),f.user);f.dialogs.openFolder=async()=> 'OS refusal';await assert.rejects(f.saves.openSaveFolder(),/OS refusal/);
});
test('save close awaits owned child work, cancels pending preview, and refuses new Start synchronously',posix,async()=>{
 const f=await fixture();await f.saves.beginImport();let closed=false;const close=f.runtime.close().then(()=>closed=true);
 await delay(20);assert.equal(closed,false);await assert.rejects(f.runtime.start(),/verified stopped/);
 await f.saves.cancelImport();await close;assert.equal(closed,true);assert.equal(f.runtime.view().closing,true);
});
test('save failed durable shutdown aborts before chooser and authority side effects',posix,async()=>{
 const f=await fixture();let chooses=0;f.dialogs.choose=async()=>{chooses++;return f.source;};f.runtime.fail(new Error('shutdown failed'));
 await assert.rejects(f.saves.beginImport(),/Previous operation failed.*shutdown failed/);assert.equal(chooses,0);await assert.rejects(readFile(join(f.resources,'calls.jsonl')),/ENOENT/);await f.runtime.verifyFailureGate();
});
test('save authority bounds output and observes child close; ambiguous mutation blocks replay',posix,async()=>{
 const f=await fixture();await f.control({overflow:true});await assert.rejects(saveAuthority(f.runtime,'preview',[]),/outputLimit=true/);assert.equal(f.runtime.view().status,'failed');await f.runtime.verifyFailureGate();
 const second=await fixture();await second.control({invalid:true});await assert.rejects(saveAuthority(second.runtime,'import',[]),/completion is unverified/);assert.equal(second.runtime.view().status,'failed');await second.runtime.verifyFailureGate();await assert.rejects(second.saves.makeBackup(),/Previous operation failed.*completion is unverified/);
});
test('save Close during authority preview does not deadlock on a later confirmation',posix,async()=>{
 const f=await fixture();await f.control({delay:100});const preview=f.saves.beginImport();
 await delay(20);const close=f.runtime.close();await f.saves.cancelImport();
 assert.equal(await preview,undefined);await close;assert.deepEqual(await readdir(join(f.user,'save-staging')),[]);
});
test('save staging cleanup preserves primary validation error and secondary cleanup failure',posix,async t=>{
 const f=await fixture();await f.control({fail:true});const original=fs.rm;
 t.mock.method(fs,'rm',async(path,...args)=>{if(String(path).includes('selected-'))throw new Error('injected cleanup denied');return original(path,...args);});
 await assert.rejects(f.saves.beginImport(),error=>/specific authority validation failure/.test(error.cause.cause.cause.message)&&/cleanup failed.*injected cleanup denied/.test(error.message));
});
test('save Close refuses accurately when an owned operation fails instead of swallowing its error',posix,async()=>{
 const f=await fixture();let release;f.dialogs.choose=()=>new Promise(ok=>release=ok);
 const preview=f.saves.beginImport().then(()=>assert.fail('missing input accepted'),error=>error);
 await delay(10);const close=f.runtime.close();release(join(f.root,'missing'));
 await assert.rejects(close,/ENOENT/);assert.match(String(await preview),/ENOENT/);assert.equal(f.runtime.view().closing,false);assert.equal(f.runtime.view().status,'stopped');
});
test('save staging refuses a file that grows during the private copy before invoking authority',posix,async t=>{
 const f=await fixture(),original=fs.open;let changed=false;
 t.mock.method(fs,'open',async(path,...args)=>{const handle=await original(path,...args);if(path===f.source){const read=handle.read.bind(handle);handle.read=async(...args)=>{const result=await read(...args);if(!changed){changed=true;await writeFile(f.source,'appended during copy',{flag:'a'});}return result;};}return handle;});
 await assert.rejects(f.saves.beginImport(),/changed while being staged/);await assert.rejects(readFile(join(f.resources,'calls.jsonl')),/ENOENT/);assert.deepEqual(await readdir(join(f.user,'save-staging')),[]);
});
test('save cleanup failure after commit retains actual completed login and refuses a false cancellation',posix,async t=>{
 const f=await fixture(),preview=await f.saves.beginImport(),original=fs.rm;
 t.mock.method(fs,'rm',async(path,...args)=>{if(String(path).includes('selected-'))throw Error('injected cleanup failure');return original(path,...args);});
 await assert.rejects(f.saves.finishImport(preview.expected,'abcde','abcde',false),error=>/Operation completed:.*player-1@local.invalid/.test(error.message)&&/cleanup failed/.test(error.message));
 assert.equal(await f.saves.cancelImport(),false);assert.equal(JSON.parse(await readFile(join(f.resources,'imported.json'),'utf8')).secretLength,5);
});
test('save restore refuses copying a live SQLite checkpoint with committed WAL bytes',posix,async()=>{
 const f=await fixture();await writeFile(f.source+'-wal','committed progress still in WAL');
 await assert.rejects(f.saves.restoreBackup(),/active WAL.*verified full backup/);await assert.rejects(readFile(join(f.resources,'calls.jsonl')),/ENOENT/);await assert.rejects(readdir(f.saves.backups),/ENOENT/);
});
test('save structured unchanged failure is safely retryable after the prerequisite is fixed',posix,async()=>{
 const f=await fixture();await f.control({fail:true});await assert.rejects(f.saves.makeBackup(),/Destination game save unchanged; output\/backup files may exist/);assert.equal(f.runtime.view().status,'stopped');await assert.rejects(readFile(join(f.user,'shutdown-failed.json')),/ENOENT/);
 await f.control({});assert.equal((await f.saves.makeBackup()).message,'Backup created.');
});
test('save unknown/malformed/missing/mismatched failure envelopes durably block replay without stderr guessing',posix,async()=>{
 for(const control of [{unknown:true},{noAck:true},{invalidUtf8:true},{fail:true,failureEnvelope:{protocol:2}},{fail:true,failureEnvelope:{operation:'restore'}},{fail:true,failureEnvelope:{outcome:'rolled-back'}},{fail:true,failureEnvelope:{error:''}},{fail:true,failureEnvelope:{extra:'unexpected'}}]){
  const f=await fixture();await f.control(control);await assert.rejects(saveAuthority(f.runtime,'import',[]),/completion is unverified/);await f.runtime.verifyFailureGate();assert.equal(f.runtime.view().status,'failed');const marker=await readFile(join(f.user,'shutdown-failed.json'),'utf8');assert.match(marker,/Replay is blocked/);assert(!marker.includes('diagnostic only; never phase evidence'));await assert.rejects(f.saves.makeBackup(),/Previous operation failed/);
 }
});
test('save early stdin EPIPE is retryable only after real close and a valid unchanged acknowledgement',posix,async t=>{
 const f=await fixture();await f.control({fail:true});const original=processes.spawn;let closed=false;
 t.mock.method(processes,'spawn',(...args)=>{const child=original(...args),end=child.stdin.end.bind(child.stdin);child.once('close',()=>closed=true);child.stdin.end=(...values)=>{process.nextTick(()=>child.stdin.emit('error',Object.assign(Error('early refusal EPIPE'),{code:'EPIPE'})));return end(...values);};return child;});
 await assert.rejects(saveAuthority(f.runtime,'import',[],'abcde'),/Destination game save unchanged/);assert(closed);assert.equal(f.runtime.view().status,'stopped');await assert.rejects(readFile(join(f.user,'shutdown-failed.json')),/ENOENT/);
 t.mock.restoreAll();await f.control({});assert.equal((await f.saves.makeBackup()).message,'Backup created.');
});
test('save non-EPIPE stdin failure cannot be rescued by an unchanged acknowledgement',posix,async t=>{
 const f=await fixture();await f.control({fail:true});const original=processes.spawn;
 t.mock.method(processes,'spawn',(...args)=>{const child=original(...args),end=child.stdin.end.bind(child.stdin);child.stdin.end=(...values)=>{process.nextTick(()=>child.stdin.emit('error',Object.assign(Error('stdin I/O failure'),{code:'EIO'})));return end(...values);};return child;});
 await assert.rejects(saveAuthority(f.runtime,'import',[],'abcde'),/completion is unverified/);await f.runtime.verifyFailureGate();assert.equal(f.runtime.view().status,'failed');
});
