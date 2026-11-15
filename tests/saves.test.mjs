import test from 'node:test';
import assert from 'node:assert/strict';
import processes from 'node:child_process';
import fs, {mkdir,mkdtemp,writeFile,readFile,readdir,stat,chmod} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Runtime} from '../dist/runtime.js';
import {SaveControls,saveAuthority,checkedPassword,isBackupName} from '../dist/saves.js';

// This executable tests transport/lifecycle only, never claims Rust save or packaged acceptance.
const executable=String.raw`#!${process.execPath}
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const [flag,command,...args]=process.argv.slice(2),control=JSON.parse(fs.readFileSync('control.json','utf8'));
if(flag!=='--local-save')process.exit(8);
const fail=(outcome,error)=>{console.log(JSON.stringify({protocol:1,operation:command,outcome,error,...control.failureEnvelope}));console.error('diagnostic only; never phase evidence');process.exitCode=2;};
fs.appendFileSync('calls.jsonl',JSON.stringify({command,args})+'\n');
const identity=()=>{const input=fs.readFileSync(args[2]);return {account:1,login:'player-1@local.invalid',replaced:!!control.replaced,disclosure:'Personal progress only.',exported_at:1700000000,name:JSON.parse(input).name,character_count:3,expected:crypto.createHash('sha256').update(input).update(control.identity||'').digest('hex')};};
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
 await mkdir('.qa/unit',{recursive:true});const root=await mkdtemp(resolve('.qa/unit/saves-')),resources=join(root,'resources'),user=join(root,'user');await mkdir(resources);await mkdir(user);await mkdir(join(user,'state'));await writeFile(join(user,'state/game.db'),'synthetic non-SQLite presence');
 const control=async value=>writeFile(join(resources,'control.json'),JSON.stringify(value));await control({});
 await writeFile(join(resources,'openrotmg'),executable,{mode:0o700});await mkdir(join(resources,'notices'));await writeFile(join(resources,'REVISION'),'a'.repeat(40));await writeFile(join(resources,'notices/account-management.json'),JSON.stringify({format:1,server:'a'.repeat(40),cli:2,storage:1}));
 const source=join(root,'selected.json');await writeFile(source,JSON.stringify({email:'player-1@local.invalid',name:'Original account'}));
 const runtime=new Runtime(resources,user);let chosen=source,confirm=true,opened;
 const dialogs={choose:async()=>chosen,confirmRestore:async()=>confirm,openFolder:async path=>{opened=path;return '';}};
 const saves=new SaveControls(runtime,dialogs);
 return {runtime,saves,dialogs,resources,user,root,source,control,choose:value=>{chosen=value;},confirm:value=>{confirm=value;},opened:()=>opened};
}
const posix={skip:process.platform==='win32'};

test('save privately staged input is bound through confirmation, passwords absent from argv and outcome',posix,async()=>{
 const f=await fixture();const preview=await f.saves.beginImport();assert.equal(preview.name,'Original account');
 await writeFile(f.source,'CHANGED EXTERNAL FILE');
 const outcome=await f.saves.finishImport(preview.expected,'secret-value','secret-value',false);
 assert.equal(outcome.login,preview.login);assert.deepEqual(JSON.parse(await readFile(join(f.resources,'imported.json'),'utf8')),{bytes:JSON.stringify({email:'player-1@local.invalid',name:'Original account'}),secretLength:12});
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
test('backup history lists regular snapshots newest first; named restore never accepts paths or symlinks',posix,async()=>{
 const f=await fixture();await f.saves.makeBackup();await f.saves.makeBackup();const [second,first]=(await f.saves.listBackups()).map(file=>({path:join(f.saves.backups,file.name)}));await fs.utimes(first.path,1,1);
 await writeFile(join(f.saves.backups,'not-a-snapshot.txt'),'ignored');await fs.symlink(first.path,join(f.saves.backups,'linked.sqlite'));
 const files=await f.saves.listBackups();assert.equal(files.length,2);assert.equal(files[0].name,second.path.split('/').at(-1));assert(files.every(file=>file.bytes>0&&file.modified>0));
 for(const name of ['../outside.sqlite','C:outside.sqlite','sub\\\\file.sqlite','x\u0000.sqlite','not-a-snapshot.txt']){assert(!isBackupName(name));await assert.rejects(f.saves.restoreBackup(name),/regular file/);}
 await assert.rejects(f.saves.restoreBackup('linked.sqlite'),/regular file/);f.confirm(true);await f.saves.restoreBackup(files[0].name);assert.equal((await f.saves.listBackups()).filter(file=>file.name.includes('-pre-restore-')).length,1);
});
test('save failed durable shutdown aborts before chooser and authority side effects',posix,async()=>{
 const f=await fixture();let chooses=0;f.dialogs.choose=async()=>{chooses++;return f.source;};f.runtime.fail(new Error('shutdown failed'));
 await assert.rejects(f.saves.beginImport(),/not confirmed/);assert.equal(chooses,0);await assert.rejects(readFile(join(f.resources,'calls.jsonl')),/ENOENT/);
});
test('save authority bounds output and observes child close; ambiguous mutation blocks replay',posix,async()=>{
 const f=await fixture();await f.control({overflow:true});await assert.rejects(saveAuthority(f.runtime,'preview',[]),/outputLimit=true/);assert.equal(f.runtime.view().status,'failed');
 const second=await fixture();await second.control({invalid:true});await assert.rejects(saveAuthority(second.runtime,'import',[]),/completion is unverified/);assert.equal(second.runtime.view().status,'failed');await assert.rejects(second.saves.makeBackup(),/not confirmed/);
});
test('save unknown/malformed/missing/mismatched failure envelopes durably block replay without stderr guessing',posix,async()=>{
 for(const control of [{unknown:true},{noAck:true},{invalidUtf8:true},{fail:true,failureEnvelope:{protocol:2}},{fail:true,failureEnvelope:{operation:'restore'}},{fail:true,failureEnvelope:{outcome:'rolled-back'}},{fail:true,failureEnvelope:{error:''}},{fail:true,failureEnvelope:{extra:'unexpected'}}]){
  const f=await fixture();await f.control(control);await assert.rejects(saveAuthority(f.runtime,'import',[]),/completion is unverified/);assert.equal(f.runtime.view().status,'failed');assert.match(f.runtime.view().message,/Replay is blocked/);assert(!f.runtime.view().message.includes('diagnostic only; never phase evidence'));await assert.rejects(f.saves.makeBackup(),/not confirmed/);
 }
});