import test from 'node:test';
import assert from 'node:assert/strict';
import {macOfflineErrorDetails} from '../scripts/macos-offline-error.mjs';

test('macos-offline-error preserves actual fetch socket cause and AggregateError details without inventing errno',()=>{
  const socket=Object.assign(new Error('connect denied'),{code:'EPERM',syscall:'connect',address:'127.0.0.1',port:12345});
  const error=new TypeError('fetch failed',{cause:new AggregateError([socket],'all connections failed')});
  const details=JSON.parse(JSON.stringify(macOfflineErrorDetails(error)));
  assert.equal(details.name,'TypeError');assert.equal(details.message,'fetch failed');assert(details.stack.includes('fetch failed'));assert(!Object.hasOwn(details,'code'));
  assert.equal(details.cause.name,'AggregateError');assert.equal(details.cause.errors[0].code,'EPERM');assert.equal(details.cause.errors[0].syscall,'connect');assert.equal(details.cause.errors[0].address,'127.0.0.1');assert.equal(details.cause.errors[0].port,12345);
  assert.deepEqual(macOfflineErrorDetails(null),{value:null});
});
