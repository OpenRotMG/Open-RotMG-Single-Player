import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {consumerEnvironment,protectWindowsInstallation} from '../scripts/native-boundaries.mjs';

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

test('native-boundaries Windows ACL denies mutation rights without denying read/synchronize',()=>{
  const calls=[],restore=protectWindowsInstallation('owned-install','S-1-5-21-500',(...args)=>calls.push(args));
  assert.deepEqual(calls,[['icacls.exe',['owned-install','/deny','*S-1-5-21-500:(OI)(CI)(WD,AD,WEA,WA,D,DC)','/T','/Q']]]);
  restore();
  assert.deepEqual(calls.slice(1),[['icacls.exe',['owned-install','/remove:d','*S-1-5-21-500','/Q']],['icacls.exe',['owned-install','/remove:d','*S-1-5-21-500','/T','/Q']]]);
});
test('native-boundaries partial Windows ACL application rolls back before propagating the real error',()=>{
  const calls=[],failure=new Error('partial ACL apply denied');
  assert.throws(()=>protectWindowsInstallation('owned-install','S-1-5-21-500',(file,args)=>{calls.push(args);if(args.includes('/deny'))throw failure;}),error=>error===failure);
  assert.equal(calls.length,3);assert(calls[1].includes('/remove:d'));assert(!calls[1].includes('/T'));assert(calls[2].includes('/T'));
});
test('native-boundaries Windows ACL rollback failure preserves both real errors without success',()=>{
  const apply=new Error('apply denied'),rollback=new Error('rollback denied');
  assert.throws(()=>protectWindowsInstallation('owned-install','S-1-5-21-500',(_file,args)=>{throw args.includes('/deny')?apply:rollback;}),error=>error instanceof AggregateError&&error.errors[0]===apply&&error.errors[1]===rollback&&error.message.includes('rollback denied'));
});
