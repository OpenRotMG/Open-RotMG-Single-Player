import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {macOfflinePolicy} from '../scripts/macos-offline-policy.mjs';
import {macOfflinePayloadCommands} from '../scripts/macos-offline-evidence.mjs';

test('macos-offline-policy excludes only literal IPv4 loopback from all-IP outbound denial and shares exact policy across payloads',()=>{
  assert.equal(macOfflinePolicy,'(version 1)\n(allow default)\n(deny network-outbound (require-all (remote ip "*:*") (require-not (remote ip "127.0.0.1:*"))))\n');
  assert.equal(createHash('sha256').update(macOfflinePolicy).digest('hex'),'c170241be9e9bd6231ef80f1b96b4dceb73beb26e40976320913493a999eeec5');
  const commands=macOfflinePayloadCommands('/same-policy.sb','/node','/canary','/chromium','/fresh-profile');
  assert.deepEqual(commands.node.slice(0,3),commands.browser.slice(0,3));assert.equal(commands.node[2],'/same-policy.sb');assert.equal(commands.node.at(-1),'/same-policy.sb');
});
