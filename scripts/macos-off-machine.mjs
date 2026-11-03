import assert from 'node:assert/strict';
import {isIPv4} from 'node:net';
import {spawnSync} from 'node:child_process';
import {macGrammarCase} from './macos-sbpl-grammar-case.mjs';

export const macOffMachinePolicy=macGrammarCase.policy;
export function offMachineMode(args) {
  assert(args.length===0||(args.length===1&&args[0]==='--off-machine-egress'),'Select only explicit --off-machine-egress or the existing diagnostic mode');return args.length===1;
}
export function macOwnIPv4Routes(interfaces,run=spawnSync) {
  const addresses=[...new Set(Object.values(interfaces).flat().filter(entry=>entry&&entry.family==='IPv4'&&isIPv4(entry.address)&&entry.address!=='0.0.0.0').map(entry=>entry.address))];
  return addresses.map(address=>{
    const command=['/sbin/route','-n','get',address],result=run(command[0],command.slice(1),{encoding:'utf8',timeout:10000});
    return {address,command,status:result.status,signal:result.signal,error:result.error&&String(result.error),stdout:result.stdout,stderr:result.stderr};
  });
}
export function requireMacLoopbackRoutes(routes) {
  assert(routes.length>0,'No assigned IPv4 route evidence; off-machine scope unknown');
  assert(routes.every(route=>{
    const interfaces=typeof route.stdout==='string'?[...route.stdout.matchAll(/^\s*interface:\s+(\S+)\s*$/gm)].map(match=>match[1]):[];
    return route.status===0&&!route.signal&&!route.error&&interfaces.length===1&&interfaces[0]==='lo0';
  }),'Each assigned own IPv4 route must be proven lo0, not ambiguous/non-loopback');
}
