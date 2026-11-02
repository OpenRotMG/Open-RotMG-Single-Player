import test from 'node:test';
import assert from 'node:assert/strict';
import {packagedChildReady} from '../scripts/package-readiness.mjs';

test('package-readiness waits for starting and returns ready only for actual Runtime readiness',()=>{
  assert.equal(packagedChildReady({status:'stopped',message:'Server is stopped',logs:[]}),false);
  assert.equal(packagedChildReady({status:'starting',message:'Preparing',logs:[]}),false);
  assert.equal(packagedChildReady({status:'ready',message:'Ready',logs:[]}),true);
});
test('package-readiness fails immediately on actual terminal startup error and preserves native diagnostics',()=>{
  assert.throws(()=>packagedChildReady({status:'stopped',message:'Cannot start: Server exited before listening: code=1',logs:['Error: noncanonical strict-source root D:\\runtime\\data\\realms']}),error=>error.message.includes('code=1')&&error.message.includes('noncanonical strict-source root')&&!error.message.includes('Timed out'));
  assert.throws(()=>packagedChildReady({status:'failed',message:'Failure gate NOT recorded',logs:['actual IO error']}),/actual IO error/);
});
