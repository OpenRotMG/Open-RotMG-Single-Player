import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {Runtime} from '../dist/runtime.js';
import {directory} from './update-fixture.mjs';

const text=await readFile('scripts/runtime-updates-test.mjs','utf8'),source=ts.createSourceFile('runtime-updates-test.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),nodes=[];
function visit(node){nodes.push(node);ts.forEachChild(node,visit);}visit(source);
const observer=nodes.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='observeFailureGate'),helper=nodes.find(n=>ts.isVariableDeclaration(n)&&n.name.getText(source)==='failedDrain');assert(observer&&helper);
function deferred(){let resolve,reject;const promise=new Promise((ok,bad)=>{resolve=ok;reject=bad;});return{promise,resolve,reject};}
test('runtime-update actual Runtime failure status precedes delayed failure persistence and retirement',async()=>{
 class ObservedRuntime extends Runtime{}const main=instrument(ObservedRuntime);
 const root=await directory('failure-settlement'),path=join(root,'runtime-recovery.json'),entered=deferred(),release=deferred(),runtime=new ObservedRuntime(root,root);await writeFile(path,JSON.stringify({state:'authorized'}));
 // Controlled publisher only: no native child, SQL, recovery authorization or save-safety proof.
 runtime.attachUpdates({persistFailure:async()=>{entered.resolve();await release.promise;await writeFile(path,JSON.stringify({state:'retired'}));}});runtime.fail(Error('controlled exposure failure'));await entered.promise;assert.equal(runtime.view().status,'failed');assert.equal(runtime.view().pid,undefined);assert.equal(JSON.parse(await readFile(path)).state,'authorized');const poll=drain(()=>runtime.view(),()=>({failureGate:main.runtimeUpdateTest.failureGate}));assert.equal(await poll(),false);let settled=false;const verified=runtime.verifyFailureGate().then(()=>{settled=true;});assert.equal(settled,false);release.resolve();await verified;assert.equal(settled,true);assert.equal(await poll(),true);assert.equal(JSON.parse(await readFile(path)).state,'retired');
});
test('runtime-update actual Runtime verifyFailureGate rejects persistence failure explicitly',async()=>{
 const root=await directory('failure-settlement-reject'),runtime=new Runtime(root,root),entered=deferred(),release=deferred();runtime.attachUpdates({persistFailure:async()=>{entered.resolve();await release.promise;throw Error('controlled publication failure');}});runtime.fail(Error('controlled Start failure'));await entered.promise;assert.equal(runtime.view().status,'failed');const verified=runtime.verifyFailureGate();release.resolve();await assert.rejects(verified,/Could not persist shutdown failure.*controlled publication failure/);
});


function instrument(Klass){const main={runtimeUpdateTest:{},process:{resourcesPath:'/packaged'},require:path=>{assert.equal(path,'/packaged/app.asar/dist/runtime.js');return{Runtime:Klass};}};runInNewContext('('+observer.getText(source)+')()',main);return main;}
function drain(view,launchObservation){return runInNewContext('('+helper.initializer.getText(source)+')',{view,launchObservation,wait:async(...args)=>{assert.equal(args.length,2);assert.equal(args[1],'unchanged deadline label');return args[0]();}}).bind(null,'unchanged deadline label');}
test('runtime-update failure observer preserves original receiver/arguments/return and observes only its gate',async()=>{
 const gate=deferred(),result={unchanged:true},args=[Error('failure'),42];let receiver,received,verified;class Controlled{fail(...values){receiver=this;received=values;return result;}verifyFailureGate(){verified=this;return gate.promise;}}const main=instrument(Controlled),runtime=new Controlled();assert.equal(main.runtimeUpdateTest.failureGate.state,'not-started');assert.equal(runtime.fail(...args),result);assert.equal(receiver,runtime);assert.equal(verified,runtime);assert.deepEqual(received,args);assert.equal(main.runtimeUpdateTest.failureGate.state,'pending');gate.resolve();await gate.promise;assert.equal(main.runtimeUpdateTest.failureGate.state,'fulfilled');
});
test('runtime-update failure observer rethrows original synchronous failure without a fake verified gate',()=>{
 const failure=Error('original fail threw');let verified=false;class Controlled{fail(){throw failure;}verifyFailureGate(){verified=true;}}const main=instrument(Controlled);assert.throws(()=>new Controlled().fail(),error=>error===failure);assert.equal(verified,false);assert.equal(main.runtimeUpdateTest.failureGate.state,'threw');
});
test('runtime-update failure observer records bounded gate rejection, never fulfillment',async()=>{
 const gate=deferred(),failure=Error('x'.repeat(1500));class Controlled{fail(){}verifyFailureGate(){return gate.promise;}}const main=instrument(Controlled);new Controlled().fail();gate.reject(failure);await assert.rejects(gate.promise,error=>error===failure);assert.equal(main.runtimeUpdateTest.failureGate.state,'rejected');assert.equal(main.runtimeUpdateTest.failureGate.error.length,1000);
});
test('runtime-update failure observer older completion cannot bless a newer current gate',async()=>{
 const first=deferred(),second=deferred();class Controlled{fail(gate){this.gate=gate;}verifyFailureGate(){return this.gate.promise;}}const main=instrument(Controlled),runtime=new Controlled();runtime.fail(first);const old=main.runtimeUpdateTest.failureGate;runtime.fail(second);const current=main.runtimeUpdateTest.failureGate;assert.notEqual(old,current);assert.equal(current.sequence,2);first.resolve();await first.promise;assert.equal(old.state,'fulfilled');assert.equal(main.runtimeUpdateTest.failureGate,current);assert.equal(current.state,'pending');second.resolve();await second.promise;assert.equal(current.state,'fulfilled');
});
test('runtime-update failure observer nested fail retains the nested current record',async()=>{
 const gate=deferred();class Controlled{fail(nested){if(!nested)this.fail(true);return nested?'inner':'outer';}verifyFailureGate(){return gate.promise;}}const main=instrument(Controlled);assert.equal(new Controlled().fail(false),'outer');const current=main.runtimeUpdateTest.failureGate;assert.equal(current.sequence,2);gate.resolve();await gate.promise;assert.equal(main.runtimeUpdateTest.failureGate,current);assert.equal(current.state,'fulfilled');
});
test('runtime-update failedDrain requires actual current gate and failed child absence, including unstarted=false',async()=>{
 for(const state of ['not-started','pending','fulfilled'])for(const status of ['ready','failed'])for(const pid of [undefined,123]){const poll=drain(()=>({status,pid}),()=>({failureGate:{state}}));assert.equal(await poll(),state==='fulfilled'&&status==='failed'&&pid===undefined);}
});
test('runtime-update failedDrain fails explicitly for rejected/thrown persistence',async()=>{
 for(const state of ['rejected','threw'])await assert.rejects(drain(()=>({status:'failed'}),()=>({failureGate:{state,error:'controlled gate failure'}}))(),/Owned failure-gate persistence failed: controlled gate failure/);
});
test('runtime-update real failed migration and own-ready branches use failedDrain before durable assertions',()=>{
 const calls=nodes.filter(n=>ts.isCallExpression(n)&&n.expression.getText(source)==='failedDrain');assert.deepEqual(calls.map(n=>n.arguments[0].text),['failed candidate actual close','actual clean drain after injected readiness exposure failure']);const observation=nodes.find(n=>ts.isBinaryExpression(n)&&n.left.getText(source)==='launchObservation');assert(observation.right.getText(source).includes('value.proof.failureGate=await app.evaluate'));const launchCall=nodes.find(n=>ts.isCallExpression(n)&&n.expression.getText(source)==='launchUpdateTest');assert(launchCall.arguments[0].getText(source).includes('observeFailureGate.toString()'));
});
test('runtime-update actual recovered crash branch already awaits close before durable assertions, without another gate wait',async()=>{
 const start=nodes.find(n=>ts.isVariableStatement(n)&&n.getText(source).startsWith('const oldMarker=')),block=start.parent,first=block.statements.indexOf(start),tail=[...block.statements].slice(first),last=tail.findIndex(n=>n.getText(source).includes("readFile(join(profile,'runtime-recovery.json'))"));assert(last>0);const segment=tail.slice(0,last+1).map(n=>n.getText(source)).join('\n'),entered=deferred(),release=deferred();let retired=false,closed=false;
 const context={profile:'owned',ownedServer:42,join,process:{kill:()=>{}},wait:async predicate=>assert.equal(await predicate(),true),view:async()=>({status:'failed'}),app:{close:async()=>{entered.resolve();await release.promise;retired=true;closed=true;return{code:1};}},report:{},assert,digest:bytes=>bytes.toString(),readFile:async path=>{if(path.endsWith('shutdown-failed.json'))return Buffer.from(closed?'new':'old');if(path.endsWith('old.json'))return Buffer.from('old');assert(path.endsWith('runtime-recovery.json'));assert.equal(closed,true);return JSON.stringify({state:retired?'retired':'authorized'});}};
 const task=runInNewContext('(async()=>{'+segment+'})()',context);await entered.promise;assert.equal(retired,false);release.resolve();await task;assert.equal(retired,true);
});
