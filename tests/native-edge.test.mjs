import test from 'node:test';
import assert from 'node:assert/strict';
import {assertNativeEdgeEnvironment,nativeEdgeLaunchOptions,openNativeOwnedEdge} from '../scripts/native-edge.mjs';

test('native-edge accepts only explicit normal Windows owned-CI mode with no extra browser flags',()=>{
  assert.doesNotThrow(()=>assertNativeEdgeEnvironment('win32','x64','true',[]));
  for(const input of [['linux','x64','true',[]],['win32','arm64','true',[]],['win32','x64','false',[]],['win32','x64','true',['--use-angle=warp']]])assert.throws(()=>assertNativeEdgeEnvironment(...input));
});
test('native-edge owned backend refuses missing prepared identity or installed-image adoption before browser creation',async()=>{
  await assert.rejects(openNativeOwnedEdge({},undefined),/Prepared owned Edge/);const sourceImage={executable:'C:\\installed\\msedge.exe',company:'Microsoft Corporation',signature:'Valid',signer:'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US',product:'Microsoft Edge',fileVersion:'156',sha256:'same'};await assert.rejects(openNativeOwnedEdge({},{sourceImage,copyMetadataBeforeRun:{...sourceImage}}),/Never apply/);await assert.rejects(openNativeOwnedEdge({},{sourceImage,copyMetadataBeforeRun:{...sourceImage,executable:'D:\\owned\\msedge.exe',sha256:'changed'}}),/must match/);
});
test('native-edge launch uses only the supplied installed image and fresh profile with native sandbox',()=>{
  const options=nativeEdgeLaunchOptions('/installed/msedge.exe','/owned/fresh-profile',{PATH:'owned'});
  assert.equal(options.executablePath,'/installed/msedge.exe');assert.equal(options.chromiumSandbox,true);assert.equal(options.ignoreDefaultArgs,true);assert.equal(options.headless,false);assert.equal(options.timeout,30000);
  assert.deepEqual(options.args,['--remote-debugging-pipe','--user-data-dir=/owned/fresh-profile','--no-first-run','--no-default-browser-check','--window-size=1280,960','about:blank']);
  assert.throws(()=>nativeEdgeLaunchOptions(undefined,'/owned/fresh-profile',{}),/Explicit installed Edge/);
});
