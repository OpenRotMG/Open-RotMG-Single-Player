import test from 'node:test';
import assert from 'node:assert/strict';
import {safariWebDriverValue} from '../scripts/safari-webdriver-response.mjs';

test('safari-webdriver-response retains numeric WebGL errors as successful script data, not usable graphics',()=>{
  const lost={supported:true,lost:true,pixel:[0,0,0,0],error:37442};
  assert.equal(safariWebDriverValue(200,{value:lost}),lost);assert.equal(lost.lost,true);assert.equal(lost.error,37442);
  const good={supported:true,lost:false,pixel:[64,128,191,255],error:0};assert.equal(safariWebDriverValue(200,{value:good}),good);
});
test('safari-webdriver-response rejects HTTP errors and standard W3C protocol error envelopes',()=>{
  assert.throws(()=>safariWebDriverValue(500,{value:{error:'session not created',message:'native failure'}}),/session not created/);
  assert.throws(()=>safariWebDriverValue(200,{value:{error:'invalid session id',message:'session gone'}}),/invalid session id/);
  assert.throws(()=>safariWebDriverValue(404,{value:null}),/HTTP404/);
});
