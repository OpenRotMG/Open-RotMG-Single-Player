import test from 'node:test';
import assert from 'node:assert/strict';
import {verifySafariProcess,verifySafariListener} from '../scripts/safari-driver-ownership.mjs';

const root={pid:3133,ppid:3000,started:'root-start',argv:'/usr/bin/safaridriver --port 43123'};
const child={pid:3139,ppid:3133,started:'child-start',argv:'/actual/Safari.app/Contents/MacOS/safaridriver --port 43123'};
test('safari-driver-ownership accepts the spawned driver or a proved wrapper descendant',()=>{
  verifySafariListener(root,{...root},[{...root}]);
  verifySafariListener(root,{...root},[{...child},{...root}]);
});
test('safari-driver-ownership rejects a foreign listener even when its argv has the same port',()=>{
  const foreign={...child,ppid:1},launchd={pid:1,ppid:0,started:'system-start',argv:'/sbin/launchd'};
  assert.throws(()=>verifySafariListener(root,root,[foreign,launchd]),/ownership is not verified/);
  assert.throws(()=>verifySafariListener(root,root,[foreign,root]),/ancestry is disconnected/);
});
test('safari-driver-ownership rejects PID reuse or changed argv before cleanup signals',()=>{
  assert.throws(()=>verifySafariProcess(child,{...child,started:'reused-pid-start'}),/started changed/);
  assert.throws(()=>verifySafariProcess(child,{...child,argv:'unrelated process'}),/argv changed/);
  assert.throws(()=>verifySafariListener(root,{...root,started:'reused-root'},[child,root]),/started changed/);
});
test('safari-driver-ownership rejects cyclic or incomplete observed ancestry',()=>{
  assert.throws(()=>verifySafariListener(root,root,[child,child,root]),/must not cycle/);
  assert.throws(()=>verifySafariListener(root,root,[{...child,started:''},root]),/Complete observed process identity/);
});
