import assert from 'node:assert/strict';
import {join} from 'node:path';

export function nativeServerBuild(source,platform,arch) {
  const command=['cargo','build','--locked','--release'];
  const targetDirectory=join(source,'target');
  if(platform==='win32') {
    assert.equal(arch,'x64','The Windows native matrix requires x64 MSVC');
    const target='x86_64-pc-windows-msvc';
    // Explicit target keeps the static consumer CRT setting off host proc-macro builds.
    command.push('--target',target,'--config',`target.${target}.rustflags=["-C","target-feature=+crt-static"]`);
    return {command,binary:join(targetDirectory,target,'release/openrotmg.exe')};
  }
  return {command,binary:join(targetDirectory,'release/openrotmg')};
}
