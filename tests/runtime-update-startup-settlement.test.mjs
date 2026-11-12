import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {Runtime} from '../dist/runtime.js';
import {RuntimeUpdates} from './update-publication-fixture.mjs';
import {AuthorityUnchangedError} from '../dist/saves.js';
import {digest} from '../dist/update-format.js';
import {runtimeFixture} from '../scripts/runtime-update-fixture.mjs';
import {directory,unitRuntime,manifestFor} from './update-fixture.mjs';

function deferred(){let resolve,reject;const promise=new Promise((ok,bad)=>{resolve=ok;reject=bad;});return{promise,resolve,reject};}
async function setup(t){
 const out=await directory('startup-settlement'),base=join(out,'base'),candidate=join(out,'candidate');await unitRuntime(base);await unitRuntime(candidate,{serverCommit:'8'.repeat(40)});const archive=join(out,'candidate.tar.gz'),manifest=await manifestFor(candidate,archive),fixture=await runtimeFixture({out,runtime:candidate,archive,target:'linux-x64',archiveInfo:{target:'linux-x64',pins:manifest.pins,startupBackup:1,clientNamespace:1,payload:manifest.payload}});t.after(()=>fixture.close());
 return{out,base,candidate,fixture};
}
test('runtime-update startup visible SERVICE precedes refusal settlement and manual check coalesces until actual completion',async t=>{
 const {out,base,fixture}=await setup(t);
 class ObservedUpdates extends RuntimeUpdates{}const observed=instrument(ObservedUpdates);
 const policy={...fixture.policy({root:base,mode:'source',startupBackup:1,clientNamespace:1,identitySha256:digest(await readFile(join(base,'build-identity.json')))}),launcher:'0.1.0'},runtime=new Runtime(base,join(out,'profile')),updates=new ObservedUpdates(runtime,policy,async()=>false),entered=deferred(),release=deferred(),original=updates.store.writeRecord;let delayed=false,sentinels=0;
 updates.store.writeRecord=async function(path,...args){if(!delayed&&path.endsWith('runtime-check-refusal.json')){delayed=true;entered.resolve();await release.promise;}return original.call(this,path,...args);};
 // Synthetic snapshot refusal, never a native authority/SQL/Windows proof.
 updates.snapshot=async(_generation,name)=>{sentinels++;await writeFile(join(runtime.userData,'backups',name),'controlled collision sentinel',{flag:'wx'});throw new AuthorityUnchangedError('controlled backup collision unchanged');};
 const startup=updates.startup();await entered.promise;assert.equal(updates.view().phase,'service');assert.equal(runtime.view().operation,undefined);assert.equal(updates.task,startup);assert.equal(observed.runtimeUpdateTest.startupCheck.state,'pending');const selected=await readFile(join(runtime.userData,'runtime-selection.json'));fixture.set('good');const before=fixture.requests.length,coalesced=updates.check();assert.equal(coalesced,startup);assert.equal(fixture.requests.length,before);assert.equal(sentinels,0);
 release.resolve();assert.equal((await coalesced).phase,'service');assert.equal(updates.task,undefined);assert.equal(observed.runtimeUpdateTest.startupCheck.state,'fulfilled');assert.equal(observed.runtimeUpdateTest.startupCheck.phase,'service');assert.equal(fixture.requests.length,before);await mkdir(runtime.runtimePaths().state,{recursive:true});await writeFile(join(runtime.runtimePaths().state,'game.db'),'synthetic non-SQLite presence only');const fresh=updates.check();assert.notEqual(fresh,startup);const result=await fresh;assert.equal(result.phase,'rejected');assert.match(result.message,/controlled backup collision unchanged/);assert.equal(sentinels,1);assert.equal(fixture.requests.filter(r=>r.path.endsWith('/latest')).length,2);assert.deepEqual(await readFile(join(runtime.userData,'runtime-selection.json')),selected);await runtime.close();
});

const text=await readFile('scripts/runtime-updates-test.mjs','utf8'),source=ts.createSourceFile('runtime-updates-test.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),nodes=[];
function visit(node){nodes.push(node);ts.forEachChild(node,visit);}visit(source);
const witness=nodes.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='observeStartupCheck'),launch=nodes.find(n=>ts.isVariableDeclaration(n)&&n.name.getText(source)==='launch');assert(witness&&launch);
function instrument(Klass){
 const main={runtimeUpdateTest:{},process:{resourcesPath:'/packaged',env:{PATH:'controlled'}},require:path=>{assert.equal(path,'/packaged/app.asar/dist/updates.js');return{RuntimeUpdates:Klass};}};runInNewContext('('+witness.getText(source)+')()',main);return main;
}
test('runtime-update startup witness preserves receiver, arguments, exact promise and bounded fulfilled view',async()=>{
 const pending=deferred(),args=['original argument'];let receiver,received;class Updates{startup(...values){receiver=this;received=values;return pending.promise;}}const main=instrument(Updates),updates=new Updates(),returned=updates.startup(...args);assert.equal(returned,pending.promise);assert.equal(receiver,updates);assert.deepEqual(received,args);assert.equal(main.runtimeUpdateTest.startupCheck.state,'pending');pending.resolve({phase:'service',mustNotRecord:'private body'});await returned;assert.equal(main.runtimeUpdateTest.startupCheck.state,'fulfilled');assert.equal(main.runtimeUpdateTest.startupCheck.phase,'service');assert.deepEqual(Object.keys(main.runtimeUpdateTest.startupCheck).sort(),['phase','state']);
});
test('runtime-update startup witness records original rejection without replacing its promise/error',async()=>{
 const pending=deferred(),failure=Error('x'.repeat(1500));class Updates{startup(){return pending.promise;}}const main=instrument(Updates),returned=new Updates().startup();assert.equal(returned,pending.promise);pending.reject(failure);await assert.rejects(returned,error=>error===failure);assert.equal(main.runtimeUpdateTest.startupCheck.state,'rejected');assert.equal(main.runtimeUpdateTest.startupCheck.error.length,1000);
});
test('runtime-update startup witness rethrows the original synchronous failure',()=>{
 const failure=Error('startup threw');class Updates{startup(){throw failure;}}const main=instrument(Updates);assert.throws(()=>new Updates().startup(),error=>error===failure);assert.equal(main.runtimeUpdateTest.startupCheck.state,'threw');assert.match(main.runtimeUpdateTest.startupCheck.error,/startup threw/);
});
function launchFixture(settle){
 const pending=deferred(),waiting=deferred(),resume=deferred(),proof={},page={waitForFunction:async()=>{}},preferences={sandbox:true,contextIsolation:true,webSecurity:true,nodeIntegration:false};let main,waitCalls=0,returned;
 class Updates{startup(){return pending.promise;}}
 const app={firstWindow:async()=>page,evaluate:async fn=>runInNewContext('('+fn.toString()+')(electron)',main)};
 const context={report:{executable:'controlled'},profile:'owned',baseline:{},setupMain:'globalThis.cutSetupSeen=true;',consumerEnv:{PATH:'controlled'},fixture:{policy:()=>({})},observeStartupCheck:runInNewContext('('+witness.getText(source)+')'),observeFailureGate:runInNewContext('('+nodes.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='observeFailureGate').getText(source)+')'),app:null,page:null,launchObservation:null,updates:async()=>({phase:'service'}),view:async()=>({}),check:(_name,passed)=>assert(passed),wait:async predicate=>{waitCalls++;assert.equal(await predicate(),false);waiting.resolve();await resume.promise;assert.equal(await predicate(),true);}};
 context.runtimeTestPortable=async(executable,profile)=>{assert.equal(executable,'controlled');assert.equal(profile,'owned');return{executablePath:'owned-bootstrap',electronPath:'owned-package',profile};};
 context.launchUpdateTest=async options=>{assert.equal(options.executablePath,'owned-bootstrap');assert.equal(options.electronPath,'owned-package');main={runtimeUpdateTest:{},process:{resourcesPath:'/packaged',env:{PATH:'controlled'}},require:()=>({RuntimeUpdates:Updates,Runtime:class{}}),electron:{BrowserWindow:{getAllWindows:()=>[{webContents:{getLastWebPreferences:()=>preferences}}]}}};runInNewContext(options.setupMain,main);returned=new Updates().startup();assert.equal(returned,pending.promise);return{app,proof};};
 const launched=runInNewContext('('+launch.initializer.getText(source)+')',context)(settle);return{launched,pending,waiting,resume,proof,get main(){return main;},get waitCalls(){return waitCalls;}};
}
for(const settle of [true,false])test(`runtime-update actual shared launch settle=${settle} respects the returned startup task`,async()=>{
 const f=launchFixture(settle);if(settle){await f.waiting.promise;assert.equal(f.proof.startupCheck.state,'pending');f.pending.resolve({phase:'service'});await f.pending.promise;f.resume.resolve();await f.launched;assert.equal(f.proof.startupCheck.state,'fulfilled');assert.equal(f.waitCalls,1);}else{await f.launched;assert.equal(f.waitCalls,0);assert.equal(f.proof.startupCheck.state,'pending');f.pending.resolve({phase:'service'});await f.pending.promise;}assert.equal(f.main.cutSetupSeen,true);assert.equal(f.proof.startupSettleRequired,settle);assert.equal(f.proof.lastKnownPhase,'service');assert.equal(f.proof.lastKnownOperation,null);
});
test('runtime-update actual shared launch predicate refuses a rejected startup task',async()=>{
 const f=launchFixture(true);await f.waiting.promise;f.pending.reject(Error('controlled startup rejection'));await assert.rejects(f.pending.promise,/controlled/);f.resume.resolve();await assert.rejects(f.launched,/Owned startup check failed/);assert.equal(f.proof.startupCheck.state,'rejected');assert.match(f.proof.startupCheck.error,/controlled startup rejection/);
});
test('runtime-update fixture records actual finished status and leaves an aborted response unknown',async t=>{
 const {fixture}=await setup(t);const failed=await fetch(fixture.policy({}).discovery);await failed.text();assert.equal(fixture.requests[0].mode,'503');assert.equal(fixture.requests[0].status,503);fixture.hold();const controller=new AbortController(),request=fetch(fixture.policy({}).discovery,{signal:controller.signal}).catch(error=>error);const entered=deferred(),push=fixture.requests.push;fixture.requests.push=function(...entries){const value=push.apply(this,entries);entered.resolve();return value;};await entered.promise;controller.abort();await request;assert.equal(fixture.requests.at(-1).status,null);
});
test('runtime-update failure finally persists bounded owned request diagnostics without request bodies',async()=>{
 const statement=nodes.find(n=>ts.isIfStatement(n)&&n.expression.getText(source)==='fixture'&&n.thenStatement.getText(source).includes('report.requests='));assert(statement);const requests=Array.from({length:10001},()=>({path:'/owned/latest',mode:'503',status:null,password:'must not persist'})),report={status:'failed'},fixture={requests,close:async()=>{requests[0].status=503;}};await runInNewContext('(async()=>{'+statement.getText(source)+'})()',{fixture,report});assert.equal(report.requests.length,10000);assert.equal(report.requestsTruncated,true);assert.equal(report.requests[0].status,503);assert.deepEqual(Object.keys(report.requests[0]).sort(),['mode','path','status']);assert.equal(report.status,'failed');
});
