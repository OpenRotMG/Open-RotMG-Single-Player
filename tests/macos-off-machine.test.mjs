import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {macOffMachinePolicy,offMachineMode,macOwnIPv4Routes,requireMacLoopbackRoutes} from '../scripts/macos-off-machine.mjs';
import {requireGrammarDenials} from '../scripts/macos-sbpl-grammar-case.mjs';
import {macOfflinePayloadCommands} from '../scripts/macos-offline-evidence.mjs';

test('macos-off-machine selects only an explicit mode and exact measured93a policy for both payloads',()=>{
  assert.equal(offMachineMode([]),false);assert.equal(offMachineMode(['--off-machine-egress']),true);assert.throws(()=>offMachineMode(['--automatic']));assert.throws(()=>offMachineMode(['--off-machine-egress','--retry']));
  assert.equal(createHash('sha256').update(macOffMachinePolicy).digest('hex'),'93a0e2158262b6b0ec46f3c499587b68073ab08965179d94f66b24c5240bb09a');
  const commands=macOfflinePayloadCommands('/same.sb','/node','/canary','/chromium','/profile');assert.deepEqual(commands.node.slice(0,3),commands.browser.slice(0,3));
  assert.throws(()=>requireGrammarDenials([{error:'ECONNREFUSED'}],'old strict case'));
});
test('macos-off-machine observes every assigned own IPv4 through readonly route get outside payload',()=>{
  const calls=[],routes=macOwnIPv4Routes({lo0:[{family:'IPv4',address:'127.0.0.1'}],en0:[{family:'IPv4',address:'192.168.64.8'},{family:'IPv6',address:'fe80::1'}]},(command,args,options)=>{calls.push({command,args,options});return {status:0,signal:null,stdout:'  interface: lo0\n',stderr:''};});
  assert.deepEqual(calls.map(call=>[call.command,...call.args]),[['/sbin/route','-n','get','127.0.0.1'],['/sbin/route','-n','get','192.168.64.8']]);assert(calls.every(call=>call.options.timeout===10000));assert.doesNotThrow(()=>requireMacLoopbackRoutes(routes));
});
test('macos-off-machine rejects ambiguous routes, command failure, timeout and unknown interfaces',()=>{
  for(const routes of [[],[{status:0,stdout:'interface: en0'}],[{status:1,stdout:'interface: lo0'}],[{status:null,signal:'SIGTERM',stdout:'interface: lo0'}],[{status:0,error:'route failed',stdout:'interface: lo0'}],[{status:0,stdout:'interface: lo0\ninterface: en0'}]])assert.throws(()=>requireMacLoopbackRoutes(routes));
});
