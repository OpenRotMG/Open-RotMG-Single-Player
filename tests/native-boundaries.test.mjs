import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {consumerEnvironment} from '../scripts/native-boundaries.mjs';

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
