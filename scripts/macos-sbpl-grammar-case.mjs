import assert from 'node:assert/strict';
import {isIPv4} from 'node:net';

export const macGrammarCase={id:'separate-tcp-localhost-allow',policy:'(version 1)\n(allow default)\n(deny network-outbound (remote ip "*:*"))\n(allow network-outbound (remote tcp "localhost:*"))\n'};
export function ownNonLoopbackIPv4(interfaces) {
  return [...new Set(Object.values(interfaces).flat().filter(entry=>entry&&!entry.internal&&entry.family==='IPv4'&&isIPv4(entry.address)&&!entry.address.startsWith('127.')&&entry.address!=='0.0.0.0').map(entry=>entry.address))];
}
export function requireGrammarDenials(results,label) {
  assert(results.length>0,`${label}: no measured addresses; scope unknown`);
  assert(results.every(result=>['EPERM','EACCES'].includes(result.error)),`${label}: actual OS permission denial required, not connection/refusal/timeout: ${JSON.stringify(results)}`);
}
