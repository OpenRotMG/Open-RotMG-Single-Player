import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tree, sha256 } from '../scripts/assets.mjs';

await mkdir('.qa/unit',{recursive:true});
test('assets tree identity is deterministic and changes with bytes',async()=>{
  const root=await mkdtemp(resolve('.qa/unit/assets-'));
  await mkdir(join(root,'data'));await writeFile(join(root,'data/a'),'one');
  const first=await tree(root,['data']);
  assert.deepEqual(first.files,{'data/a':sha256('one')});
  assert.deepEqual(await tree(root,['data']),first);
  await writeFile(join(root,'data/a'),'two');
  assert.notEqual((await tree(root,['data'])).sha256,first.sha256);
});
test('assets rejects symlink injection instead of copying an unpinned target',{skip:process.platform==='win32'},async()=>{
  const root=await mkdtemp(resolve('.qa/unit/assets-'));
  await writeFile(join(root,'outside'),'not pinned');await symlink('outside',join(root,'asset'));
  await assert.rejects(tree(root,['asset']),/Symlink is not a pinned asset/);
});
