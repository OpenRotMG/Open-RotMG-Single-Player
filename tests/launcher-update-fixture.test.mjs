import test from 'node:test';
import assert from 'node:assert/strict';
import {offlineRuntimeFixturePolicy} from '../scripts/verify-launcher-update.mjs';

test('future launcher fixture retains runtime authority but declares discovery unavailable without contacting public latest',async()=>{
 const authority=Object.freeze({publicKey:Symbol('publisher'),minimumSequence:3,request:()=>{throw Error('Public runtime discovery must not run in the owned fixture');}}),factory=new Function('Response',`return (${offlineRuntimeFixturePolicy.toString()});`)(Response);let args;
 const policy=factory((...value)=>{args=value;return authority;})('owned-resources','0.1.6');assert.deepEqual(args,['owned-resources','0.1.6']);assert.equal(policy.publicKey,authority.publicKey);assert.equal(policy.minimumSequence,3);assert.equal((await policy.request('https://api.github.com/unused')).status,503);assert.notEqual(policy.request,authority.request);assert(Object.isFrozen(authority));
});
