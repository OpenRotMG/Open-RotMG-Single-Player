import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
const tick=()=>new Promise(ok=>setImmediate(ok));
const metadata={account:1,login:'player-1@local.invalid',replaced:true,disclosure:'Personal progress only.',exported_at:1700000000,name:'Guest1',character_count:2,expected:'a'.repeat(64)};
async function fixture(){
 const elements=new Map(),calls=[];let change,finish,reject,cancel=true;
 const element=id=>{if(!elements.has(id))elements.set(id,{textContent:'',value:'',disabled:false,hidden:true});return elements.get(id);};
 const launcher={launcherUpdates:async()=>({installed:'0.1.1',phase:'idle',message:''}),updates:async()=>({phase:'ready',message:'Fixture, not a runtime check',canPlayInstalled:false,canRecover:false,canRetry:false}),updatesChanged(){},status:async()=>({status:'stopped',logs:[],message:'Stopped',diagnostics:'private',closing:false}),changed:callback=>change=callback,importPlayer:async()=>metadata,confirmImport:(...args)=>{calls.push(args);return new Promise((ok,bad)=>{finish=ok;reject=bad;});},cancelImport:async()=>cancel};
 const source=ts.transpileModule(await readFile('src/renderer.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 runInNewContext(source,{exports:{},URL,document:{getElementById:element},window:{launcher,addEventListener(){}}});await tick();
 return{element,calls,launcher,change:view=>change(view),finish:value=>finish(value),reject:error=>reject(error),cancel:value=>cancel=value};
}
test('renderer navigation separates Home, Settings and logs without losing state; the game link uses the checked client operation',async()=>{
 const f=await fixture();let clients=0;f.launcher.client=async()=>clients++;
 f.element('show-settings').onclick();assert.equal(f.element('settings-page').hidden,false);assert.equal(f.element('home-page').hidden,true);assert.equal(f.element('logs-page').hidden,true);
 f.element('password').value='not retained when leaving';f.element('show-logs').onclick();assert.equal(f.element('logs-page').hidden,false);assert.equal(f.element('settings-page').hidden,true);assert.equal(f.element('password').value,'');
 f.change({status:'ready',clientURL:'http://127.0.0.1:47832/_runtime/'+'a'.repeat(64)+'/',logs:['server fixture'],message:'Ready at backend',diagnostics:'private/diagnostics',closing:false});
 assert.equal(f.element('client-url').textContent,'http://127.0.0.1:47832/');assert.equal(f.element('client-url').href,'http://127.0.0.1:47832/');assert.equal(f.element('client-url').hidden,false);
 let prevented=false;f.element('client-url').onclick({preventDefault(){prevented=true;}});await tick();assert(prevented);assert.equal(clients,1);assert.equal(f.element('diagnostics').textContent,'Detailed logs: private/diagnostics');
 f.change({status:'stopped',logs:[],message:'Stopped',diagnostics:'private',closing:false});assert.equal(f.element('client-url').hidden,true);f.element('show-home').onclick();assert.equal(f.element('home-page').hidden,false);assert.equal(f.element('logs-page').hidden,true);
});
test('renderer shows truthful preview/login/replacement warning and clears password fields before awaiting commit',async()=>{
 const f=await fixture();f.element('import').onclick();await tick();assert.equal(f.element('local-login').value,metadata.login);assert.equal(f.element('replace-warning').hidden,false);assert.match(f.element('import-summary').textContent,/Guest1.*exported.*2 owned characters/s);
 f.element('password').value='private';f.element('confirmation').value='private';f.element('import-confirm').onclick();
 assert.equal(f.element('password').value,'');assert.equal(f.element('confirmation').value,'');assert.equal(f.element('import-cancel').disabled,true);assert.deepEqual(f.calls,[[metadata.expected,'private','private',true]]);
 f.element('import-confirm').onclick();assert.equal(f.calls.length,1);f.finish({message:'Imported',login:metadata.login});await tick();assert.equal(f.element('import-preview').hidden,true);assert.equal(f.element('save-result').textContent,'Imported');
});
test('renderer failure retains error, clears fields, and never claims cancellation after a consumed commit',async()=>{
 const f=await fixture();f.element('import').onclick();await tick();f.element('password').value='private';f.element('confirmation').value='private';f.element('import-confirm').onclick();f.reject(Error('stale expectation; preview again'));await tick();assert.match(f.element('error').textContent,/stale/);assert.equal(f.element('password').value,'');assert.equal(f.element('confirmation').value,'');
 f.cancel(false);f.element('import-cancel').onclick();await tick();assert.match(f.element('error').textContent,/No pending preview was canceled/);assert.equal(f.element('import-preview').hidden,true);
});
test('renderer lifecycle view disables conflicting options and clears unsubmitted passwords on Close',async()=>{
 const f=await fixture();f.element('import').onclick();await tick();f.element('password').value='private';f.element('confirmation').value='private';f.change({status:'stopped',logs:[],message:'Closing',diagnostics:'private',closing:true,operation:'Import player'});
 for(const id of ['start','stop','client','import','backup','folder','restore'])assert(f.element(id).disabled,id);assert.equal(f.element('password').value,'');assert.equal(f.element('confirmation').value,'');assert.equal(f.element('import-preview').hidden,true);
});
test('renderer hides a consumed failed confirmation on lifecycle settlement without replacing its primary error',async()=>{
 const f=await fixture();f.element('import').onclick();await tick();f.element('password').value='private';f.element('confirmation').value='private';f.element('import-confirm').onclick();
 f.change({status:'stopped',logs:[],message:'Stopped',diagnostics:'private',closing:false});assert.equal(f.element('import-preview').hidden,true);
 f.reject(Error('Destination game save unchanged: backup permission denied'));await tick();assert.match(f.element('error').textContent,/Destination game save unchanged: backup permission denied/);assert.equal(f.element('password').value,'');
});
