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

const paths=['owned-install/nested/file','owned-install/nested','owned-install'];
test('native-boundaries Windows ACL applies granular rights in postorder without recursive self-denial',()=>{
  const calls=[],restore=protectWindowsInstallation(paths,'S-1-5-21-500',(...args)=>calls.push(args));
  assert.deepEqual(calls,paths.map(path=>['icacls.exe',[path,'/deny','*S-1-5-21-500:(OI)(CI)(WD,AD,WEA,WA,D,DC)','/Q']]));
  restore();
  assert.deepEqual(calls.slice(3),[...paths].reverse().map(path=>['icacls.exe',[path,'/remove:d','*S-1-5-21-500','/Q']]));
});
test('native-boundaries partial Windows ACL application rolls back root-first before propagating the real error',()=>{
  const calls=[],failure=new Error('partial ACL apply denied');
  assert.throws(()=>protectWindowsInstallation(paths,'S-1-5-21-500',(_file,args)=>{calls.push(args);if(args[0]===paths[1]&&args.includes('/deny'))throw failure;}),error=>error===failure);
  assert.equal(calls.length,5);assert.deepEqual(calls.slice(2).map(args=>args[0]),[...paths].reverse());assert(calls.every(args=>!args.includes('/T')));
});
test('native-boundaries Windows ACL rollback continues after errors and preserves apply plus rollback failures',()=>{
  const apply=new Error('apply denied'),rollback=new Error('rollback denied'),attempts=[];
  assert.throws(()=>protectWindowsInstallation(paths,'S-1-5-21-500',(_file,args)=>{if(args.includes('/deny'))throw apply;attempts.push(args[0]);throw rollback;}),error=>error instanceof AggregateError&&error.errors[0]===apply&&error.errors[1].errors.length===3&&error.message.includes('rollback denied'));
  assert.deepEqual(attempts,[...paths].reverse());
});
