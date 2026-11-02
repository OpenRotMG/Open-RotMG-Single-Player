import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {macGrammarCase,ownNonLoopbackIPv4,requireGrammarDenials} from '../scripts/macos-sbpl-grammar-case.mjs';

test('macos-sbpl-grammar has exactly one fixed independent candidate, not a policy fallback or numeric-address claim',()=>{
  assert.equal(macGrammarCase.id,'separate-tcp-localhost-allow');
  assert.equal(macGrammarCase.policy,'(version 1)\n(allow default)\n(deny network-outbound (remote ip "*:*"))\n(allow network-outbound (remote tcp "localhost:*"))\n');
  assert.equal(createHash('sha256').update(macGrammarCase.policy).digest('hex'),'93a0e2158262b6b0ec46f3c499587b68073ab08965179d94f66b24c5240bb09a');
});
test('macos-sbpl-grammar derives only actual guest assigned non-loopback IPv4 destinations',()=>{
  const interfaces={lo0:[{address:'127.0.0.1',family:'IPv4',internal:true}],en0:[{address:'10.2.3.4',family:'IPv4',internal:false},{address:'fe80::1',family:'IPv6',internal:false}],en1:[{address:'10.2.3.4',family:'IPv4',internal:false}]};
  assert.deepEqual(ownNonLoopbackIPv4(interfaces),['10.2.3.4']);assert.deepEqual(ownNonLoopbackIPv4({}),[]);
});
test('macos-sbpl-grammar refuses unknown scope, successful connections, refusal and timeout as denial proof',()=>{
  assert.doesNotThrow(()=>requireGrammarDenials([{error:'EPERM'},{error:'EACCES'}],'measured'));
  for(const results of [[],[{connected:true}],[{error:'ECONNREFUSED'}],[{timeout:true}],[{error:'ENETUNREACH'}]])assert.throws(()=>requireGrammarDenials(results,'own guest addresses'));
});
