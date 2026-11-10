import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
const tick=()=>new Promise(ok=>setImmediate(ok));
async function fixture(){
 const elements=new Map(),calls=[];let changed,updated;
 const element=id=>{if(!elements.has(id))elements.set(id,{textContent:'',disabled:false,hidden:true,value:''});return elements.get(id);};
 const runtime={status:'stopped',message:'Stopped',diagnostics:'private',logs:[],closing:false};
 const installed={version:'source-unit',kind:'source',sequence:0,server:'2c700135d755a4210c2204334aafee2572205ec1',client:'d3016983e6fa807be8bf700001e0ba2cf0fc2a7e',ruffle:'unit.1'};
 let update={phase:'ready',message:'Installed, not claiming latest',installed,canPlayInstalled:false,canRecover:false,canRetry:false};
 const launcher={launcherUpdates:async()=>({installed:'0.1.1',phase:'idle',message:''}),status:async()=>runtime,updates:async()=>update,changed:fn=>changed=fn,updatesChanged:fn=>updated=fn,checkUpdates:async()=>{calls.push(['check']);return update;},startInstalled:async()=>calls.push(['installed']),retryUpdate:async()=>{calls.push(['retry']);return update;},recoverRuntime:async()=>{calls.push(['recover']);return update;},releases:async()=>calls.push(['releases'])};
 const source=ts.transpileModule(await readFile('src/renderer.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 runInNewContext(source,{exports:{},document:{getElementById:element},window:{launcher,addEventListener(){}}});await tick();
 return{element,calls,launcher,runtime,installed,change:v=>changed({...runtime,...v}),update:v=>{update={...update,...v};updated(update);}};
}
test('renderer-updates shows exact installed/available pair and specific service error without false latest',async()=>{
 const f=await fixture();assert.match(f.element('update-installed').textContent,/source build/);assert.match(f.element('update-installed').textContent,/Server commit #2542 · Client commit #88/);assert(!f.element('update-installed').textContent.includes(f.installed.server));
 f.update({phase:'service',message:'Runtime service HTTP 503; not offline',canPlayInstalled:true});assert.match(f.element('update-message').textContent,/HTTP 503/);assert.equal(f.element('play-installed').hidden,false);
 f.element('play-installed').onclick();await tick();assert.deepEqual(f.calls,[['installed']]);
 f.update({available:{...f.installed,kind:'release',sequence:2,version:'fixture-C',server:'c'.repeat(40),client:'d'.repeat(40)}});assert.match(f.element('update-available').textContent,/fixture-C/);assert.match(f.element('update-available').textContent,/Server commit number unavailable · Client commit number unavailable/);assert(!f.element('update-available').textContent.includes('c'.repeat(40)));
});
test('renderer-updates permits checks during play but disables conflicting lifecycle/recovery actions',async()=>{
 const f=await fixture();f.change({status:'ready',pid:123});assert.equal(f.element('check-updates').disabled,false);f.element('check-updates').onclick();await tick();assert.deepEqual(f.calls,[['check']]);
 f.change({status:'stopped',operation:'Import player'});for(const id of ['check-updates','play-installed','retry-update','recover-runtime'])assert(f.element(id).disabled,id);
 f.change({status:'failed'});f.update({phase:'recovery',message:'Unknown completion',canRecover:true,canPlayInstalled:false});assert.equal(f.element('recover-runtime').hidden,false);assert.equal(f.element('recover-runtime').disabled,false);assert.equal(f.element('play-installed').hidden,true);
 f.change({status:'failed',pid:123});assert.equal(f.element('recover-runtime').disabled,true);f.change({status:'failed',closing:true});assert.equal(f.element('recover-runtime').disabled,true);
});
test('launcher and server/client update controls stay separate and launcher replacement steps are explicit',async()=>{
 const f=await fixture();f.launcher.checkLauncher=async()=>({installed:'0.1.1',available:'0.1.2',phase:'available',message:'Launcher 0.1.2 is available.'});f.launcher.downloadLauncher=async()=>f.calls.push(['download-launcher']);
 f.update({phase:'service',message:'Game runtime HTTP 503',canPlayInstalled:true});f.element('check-launcher').onclick();await tick();
 assert.equal(f.element('launcher-version').textContent,'Installed: 0.1.1');assert.equal(f.element('download-launcher').hidden,false);assert.equal(f.element('launcher-update-steps').hidden,false);assert.match(f.element('update-message').textContent,/Game runtime HTTP 503/);
 f.element('download-launcher').onclick();await tick();assert.deepEqual(f.calls,[['download-launcher']]);
});
test('renderer-updates minimum-launcher action invokes only the named fixed release-page operation',async()=>{
 const f=await fixture();f.update({phase:'launcher',message:'Requires launcher 0.2.0',canPlayInstalled:true});assert.equal(f.element('runtime-releases').hidden,false);f.element('runtime-releases').onclick();await tick();assert.deepEqual(f.calls,[['releases']]);
 f.update({phase:'rejected',message:'Quarantined exact candidate',canRetry:true});assert.equal(f.element('retry-update').hidden,false);f.element('retry-update').onclick();await tick();assert.deepEqual(f.calls.at(-1),['retry']);
});
