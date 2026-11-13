import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

const text=await readFile('scripts/runtime-updates-test.mjs','utf8'),source=ts.createSourceFile('runtime-updates-test.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const helper=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='publishedRecordCut');assert(helper);
const setups=[];function visit(node){if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&node.left.getText(source)==='setupMain'&&node.right.getText(source).includes('publishedRecordCut('))setups.push(node.right.getText(source));ts.forEachChild(node,visit);}visit(source);assert.equal(setups.length,2);
const profile=join('owned root','profile'),hold="globalThis.runtimeUpdateTest.cutHeld=true;await new Promise(()=>{globalThis.runtimeUpdateTest.releaseCut=()=>process.kill(process.pid,'SIGKILL');});";
function emitted(boundary){
 const publishedRecordCut=runInNewContext('('+helper.getText(source)+')');
 return runInNewContext(setups[boundary==='restore'?1:0],{publishedRecordCut,join,profile,boundary,hold,runtimeTestStorage:profile=>profile});
}
const records={bootstrap:{initialized:false},selection:{kind:'update',phase:'selected'},restore:{phase:'recovering',recovery:{kind:'restore',receiptSha256:'receipt'}}};
const pathFor=boundary=>join(profile,boundary==='bootstrap'?'runtime-profile.json':'runtime-pending.json');
function fixture(boundary,route,published=records[boundary]){
 const files=new Map(),reads=[],calls=[],kills=[],runtimeUpdateTest={cutRecovery:true},result={published:true};let resolve,reject;
 const completion=new Promise((ok,bad)=>{resolve=ok;reject=bad;});
 const routes={durableBytes:async(path)=>{await completion;files.set(path,JSON.stringify(published));},nativeAckAndClose:async(path)=>{await completion;files.set(path,JSON.stringify(published));}};
 class RuntimeStore{async writeRecord(...args){calls.push({receiver:this,args,route});await routes[route](args[0]);return result;}}
 runInNewContext(emitted(boundary),{require:name=>{assert.equal(name,'/packaged/app.asar/dist/update-store.js');return{RuntimeStore};},process:{resourcesPath:'/packaged',pid:1234,kill:(...args)=>kills.push(args)},fs:{readFileSync:path=>{reads.push(path);assert(files.has(path));return files.get(path);}},runtimeUpdateTest});
 return{store:new RuntimeStore(),resolve,reject,reads,calls,kills,runtimeUpdateTest,result};
}
const tick=()=>new Promise(ok=>setImmediate(ok));
// Controlled routes exercise the emitted journey hooks, not native Windows publication or actual process cuts.
for(const route of ['durableBytes','nativeAckAndClose'])for(const boundary of ['bootstrap','selection','restore']){
 test(`runtime-update publication ${boundary} cut waits for completed ${route} and actual readback`,async()=>{
  const f=fixture(boundary,route),args=[pathFor(boundary),{notThePublishedRecord:true},true],pending=f.store.writeRecord(...args);await tick();assert.equal(f.calls[0].receiver,f.store);assert.deepEqual(f.calls[0].args,args);assert.equal(f.calls[0].route,route);assert.deepEqual(f.reads,[]);assert.deepEqual(f.kills,[]);assert.equal(f.runtimeUpdateTest.cutHeld,undefined);
  f.resolve();await tick();assert.deepEqual(f.reads,[args[0]]);
  if(boundary==='restore'){assert.equal(await pending,f.result);assert.deepEqual(f.kills[0],[1234,'SIGKILL']);}
  else{assert.equal(f.runtimeUpdateTest.cutHeld,true);assert.deepEqual(f.kills,[]);f.runtimeUpdateTest.releaseCut();assert.deepEqual(f.kills[0],[1234,'SIGKILL']);}
 });
 test(`runtime-update publication ${boundary} rejection on ${route} never reads or cuts`,async()=>{
  const f=fixture(boundary,route),failure=Error('publication failed'),pending=f.store.writeRecord(pathFor(boundary),records[boundary]);f.reject(failure);await assert.rejects(pending,error=>error===failure);assert.deepEqual(f.reads,[]);assert.deepEqual(f.kills,[]);assert.equal(f.runtimeUpdateTest.cutHeld,undefined);
 });
 test(`runtime-update publication ${boundary} on ${route} preserves return and rejects foreign paths/states`,async()=>{
  const wrongStates=boundary==='bootstrap'?[{initialized:true},{}]:boundary==='selection'?[{kind:'start',phase:'selected'},{kind:'update',phase:'staged'}]:[{phase:'selected',recovery:{kind:'restore',receiptSha256:'receipt'}},{phase:'recovering',recovery:{kind:'current',receiptSha256:'receipt'}},{phase:'recovering',recovery:{kind:'restore'}},{}];
  for(const [path,published,enabled] of [[join(profile+'-foreign',boundary==='bootstrap'?'runtime-profile.json':'runtime-pending.json'),records[boundary],true],...wrongStates.map(record=>[pathFor(boundary),record,true]),...(boundary==='restore'?[[pathFor(boundary),records[boundary],false]]:[])]){
   const f=fixture(boundary,route,published);f.runtimeUpdateTest.cutRecovery=enabled;const args=[path,records[boundary],false],pending=f.store.writeRecord(...args);f.resolve();assert.equal(await pending,f.result);assert.equal(f.calls[0].receiver,f.store);assert.deepEqual(f.calls[0].args,args);assert.deepEqual(f.kills,[]);assert.equal(f.runtimeUpdateTest.cutHeld,undefined);assert.deepEqual(f.reads,path===pathFor(boundary)?[path]:[]);
  }
 });
}
