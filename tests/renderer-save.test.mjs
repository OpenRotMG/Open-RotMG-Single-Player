import test from 'node:test';
import assert from 'node:assert/strict';
import {rendererFixture,tick,metadata} from './renderer-fixture.mjs';
test('XP navigation keeps Settings selected, groups backup locations, and has Logs inside Advanced',async()=>{
 const f=await rendererFixture();f.element('show-backups').onclick();await tick();assert.equal(f.element('settings-page').hidden,false);assert.equal(f.element('home-page').hidden,true);assert.equal(f.element('show-settings').getAttribute('aria-current'),'page');assert.equal(f.element('tab-backups').getAttribute('aria-selected'),'true');assert.equal(f.element('save-location').textContent,'/owned/player data');
 f.element('show-advanced').onclick();assert.equal(f.element('advanced-page').hidden,false);assert.equal(f.element('backups-page').hidden,true);assert.equal(f.element('show-settings').getAttribute('aria-current'),'page');
 assert(!f.elements.has('show-logs'));assert(!f.elements.has('finish-update'));assert(!f.elements.has('password'));assert(!f.elements.has('confirmation'));assert.match(f.html,/<code id="import-password">password<\/code>/);
 f.element('tab-advanced').onkeydown({key:'Home',preventDefault(){}});assert.equal(f.element('tab-backups').getAttribute('aria-selected'),'true');assert(f.element('tab-backups').focused);
});
test('Play waits for owned startup, opens once, and a failed startup never opens the game',async()=>{
 const f=await rendererFixture();let ready;f.launcher.start=()=>new Promise(resolve=>ready=resolve);
 f.element('play').onclick();assert(f.element('play').disabled);assert.deepEqual(f.calls,[]);ready();await tick();assert.deepEqual(f.calls,[['client']]);
 f.calls.length=0;f.launcher.start=async()=>{throw Error('startup refused');};f.element('play').onclick();await tick();assert.deepEqual(f.calls,[]);assert.match(f.element('error').textContent,/startup refused/);
 f.change({status:'ready',clientURL:'http://127.0.0.1:47832/_runtime/'+'a'.repeat(64)+'/'});f.element('client-url').onclick({preventDefault(){}});await tick();assert.deepEqual(f.calls,[['client']]);assert.equal(f.element('client-url').textContent,'http://127.0.0.1:47832/');
});
test('import preview has fixed password and exact replacement scope; renderer cannot choose a password',async()=>{
 const f=await rendererFixture();let finish;f.change({operation:'Import player'});f.launcher.confirmImport=(...args)=>{f.calls.push(args);return new Promise(resolve=>finish=resolve);};
 f.element('import').onclick();await tick();assert(f.element('import-preview').open);assert.equal(f.element('local-login').value,metadata.login);assert.equal(f.element('replace-warning').hidden,false);assert.match(f.element('import-summary').textContent,/Guest1.*2 characters/);
 f.element('import-confirm').onclick();f.element('import-confirm').onclick();assert.deepEqual(f.calls,[[metadata.expected,true]]);assert(f.element('import-cancel').disabled);
 finish({message:'Imported',login:metadata.login});await tick();assert(!f.element('import-preview').open);assert.equal(f.element('home-result').textContent,'Account imported.');assert.equal(f.element('account-login').textContent,metadata.login);assert.equal(f.element('imported-account').hidden,false);
});
test('Escape cancels the authority preview; a consumed failed commit retains its primary error without claiming cancellation',async()=>{
 const f=await rendererFixture();f.element('import').onclick();await tick();let prevented=false;f.element('import-preview').oncancel({preventDefault(){prevented=true;}});await tick();assert(prevented);assert(!f.element('import-preview').open);
 f.element('import').onclick();await tick();let reject;f.change({operation:'Import player'});f.launcher.confirmImport=()=>new Promise((_ok,bad)=>reject=bad);f.element('import-confirm').onclick();f.change({operation:undefined});reject(Error('Destination unchanged: backup permission denied'));await tick();assert(!f.element('import-preview').open);assert.match(f.element('error').textContent,/Destination unchanged/);assert.match(f.element('logs').textContent,/backup permission denied/);
});
test('backup list selects only a displayed leaf; restore cancellation preserves displayed login; Close disables conflicting controls',async()=>{
 const f=await rendererFixture();f.launcher.listBackups=async()=>[{name:'first.sqlite',modified:1700000000000,bytes:42}];f.element('show-backups').onclick();await tick();assert.equal(f.element('backup-list').children.length,1);assert.equal(f.element('restore').disabled,false);
 f.element('imported-account').hidden=false;f.launcher.restoreBackup=async name=>{f.calls.push(name);return undefined;};f.element('restore').onclick();await tick();assert.deepEqual(f.calls,['first.sqlite']);assert.equal(f.element('imported-account').hidden,false);
 f.change({closing:true,operation:'Import player'});for(const id of ['play','start','stop','client','import','backup','folder','restore','restore-other','save-folder'])assert(f.element(id).disabled,id);assert(!f.element('import-preview').open);
});
