import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {consumerEnvironment,protectWindowsInstallation,windowsProcessIdentity} from '../scripts/native-boundaries.mjs';

test('native-boundaries consumer PATH is empty and cannot inherit developer search paths',async()=>{
  await mkdir('.qa/unit',{recursive:true});
  const out=await mkdtemp(resolve('.qa/unit/consumer-env-'));
  try{
    const env=await consumerEnvironment({Path:'developer-bin',PATH:'other-bin',NODE_OPTIONS:'--require injected',NODE_PATH:'modules',PYTHONPATH:'python',PYTHONHOME:'home',CARGO_HOME:'cargo',RUSTUP_HOME:'rustup',SystemRoot:'system',HOME:'user'},out);
    assert.equal(env.PATH,join(out,'no-developer-tools'));
    assert.deepEqual(await readdir(env.PATH),[]);
    assert.deepEqual(Object.keys(env).sort(),['HOME','PATH','SystemRoot']);
  }finally{await rm(out,{recursive:true});}
});

test('native-boundaries Windows process identity preserves actual PID/start/argv/image using explicit PS7',()=>{
  const old=process.env.ProgramFiles;process.env.ProgramFiles='/owned/program-files';
  const identity={pid:123,started:'actual-start',argv:'msedge --user-data-dir=fresh-profile',executable:'actual-msedge.exe'},calls=[];
  try{
    assert.deepEqual(windowsProcessIdentity(123,(...args)=>{calls.push(args);return JSON.stringify(identity);}),identity);
    assert(calls[0][0].endsWith(join('PowerShell','7','pwsh.exe')));assert(calls[0][1].at(-1).includes("ProcessId=123"));assert(calls[0][1].at(-1).includes('CreationDate.ToUniversalTime()'));assert.equal(calls[0][2].timeout,30000);
    assert.throws(()=>windowsProcessIdentity('123; injected'),/Positive Windows process PID required/);assert.equal(calls.length,1);
  }finally{if(old===undefined)delete process.env.ProgramFiles;else process.env.ProgramFiles=old;}
});

const paths=['owned-install/nested/file','owned-install/nested','owned-install'];
test('native-boundaries Windows ACL uses a PS7 mutation-only .NET deny batch with exact mask readback',()=>{
  const calls=[],restore=protectWindowsInstallation(paths,'S-1-5-21-500','test-pwsh',(...args)=>calls.push(args));
  assert.equal(calls.length,1);assert.equal(calls[0][0],'test-pwsh');assert.deepEqual(JSON.parse(calls[0][2].input),paths);
  const script=calls[0][1].at(-1);assert(script.includes('FileSystemRights]0x10156'));assert(script.includes('AccessControlType]::Deny'));assert(script.includes('FileSystemRights -ne 0x10156'));assert(!script.includes('icacls'));
  restore();
  assert.deepEqual(calls.slice(1),[...paths].reverse().map(path=>['icacls.exe',[path,'/remove:d','*S-1-5-21-500','/Q']]));
});
test('native-boundaries partial Windows ACL application rolls back root-first before propagating the real error',()=>{
  const calls=[],failure=new Error('partial ACL apply denied');
  assert.throws(()=>protectWindowsInstallation(paths,'S-1-5-21-500','test-pwsh',(file,args)=>{calls.push(args);if(file==='test-pwsh')throw failure;}),error=>error===failure);
  assert.equal(calls.length,4);assert.deepEqual(calls.slice(1).map(args=>args[0]),[...paths].reverse());assert(calls.every(args=>!args.includes('/T')));
});
test('native-boundaries Windows ACL rollback continues after errors and preserves apply plus rollback failures',()=>{
  const apply=new Error('apply denied'),rollback=new Error('rollback denied'),attempts=[];
  assert.throws(()=>protectWindowsInstallation(paths,'S-1-5-21-500','test-pwsh',(file,args)=>{if(file==='test-pwsh')throw apply;attempts.push(args[0]);throw rollback;}),error=>error instanceof AggregateError&&error.errors[0]===apply&&error.errors[1].errors.length===3&&error.message.includes('rollback denied'));
  assert.deepEqual(attempts,[...paths].reverse());
});
