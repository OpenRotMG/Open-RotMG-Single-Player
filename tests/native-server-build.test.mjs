import test from 'node:test';
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {nativeServerBuild} from '../scripts/native-server-build.mjs';

const source=resolve('.qa/server');
test('native-server-build Windows command uses explicit native MSVC target and static consumer CRT',()=>{
  const build=nativeServerBuild(source,'win32','x64');
  assert.deepEqual(build.command,['cargo','build','--locked','--release','--target','x86_64-pc-windows-msvc','--config','target.x86_64-pc-windows-msvc.rustflags=["-C","target-feature=+crt-static"]']);
  assert.equal(build.binary,join(source,'target/x86_64-pc-windows-msvc/release/openrotmg.exe'));
  assert.throws(()=>nativeServerBuild(source,'win32','arm64'),/requires x64 MSVC/);
});
test('native-server-build preserves ordinary Linux and both macOS native commands and binary paths',()=>{
  for(const [platform,arch] of [['linux','x64'],['darwin','x64'],['darwin','arm64']]){
    const build=nativeServerBuild(source,platform,arch);
    assert.deepEqual(build.command,['cargo','build','--locked','--release']);
    assert.equal(build.binary,join(source,'target/release/openrotmg'));
  }
});
