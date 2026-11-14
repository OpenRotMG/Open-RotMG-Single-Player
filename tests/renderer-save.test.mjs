import test from 'node:test';
import assert from 'node:assert/strict';
import {rendererFixture,tick,metadata} from './renderer-fixture.mjs';
test('XP navigation keeps Settings selected, grouped backups and Advanced logs',async()=>{
 const f=await rendererFixture();f.element('show-backups').onclick();await tick();assert.equal(f.element('settings-page').hidden,false);assert.equal(f.element('show-home').getAttribute('aria-current'),'false');assert.equal(f.element('tab-backups').getAttribute('aria-selected'),'true');assert.equal(f.element('save-location').textContent,'/owned/player data');
 f.element('show-updates').onclick();assert.equal(f.element('updates-page').hidden,false);assert.equal(f.element('show-settings').getAttribute('aria-current'),'page');assert(!f.elements.has('show-logs'));assert(!f.elements.has('finish-update'));assert(!f.elements.has('imported-account'));assert(!f.elements.has('home-result'));
 f.element('tab-advanced').onkeydown({key:'Home',preventDefault(){}});assert.equal(f.element('tab-accounts').getAttribute('aria-selected'),'true');assert(f.element('tab-accounts').focused);
});
test('bots default off, change only on a click, and cannot change while a game is running',async()=>{const f=await rendererFixture();assert.equal(f.element('bots-enabled').checked,false);assert.deepEqual(f.calls,[]);f.element('bots-enabled').checked=true;f.element('bots-enabled').onchange({target:f.element('bots-enabled')});assert.equal(f.element('bots-enabled').checked,true);assert.equal(f.element('bots-enabled').disabled,true);await tick();assert.deepEqual(f.calls,[['bots',true]]);assert.equal(f.element('bots-enabled').checked,true);f.change({status:'ready'});assert.equal(f.element('bots-enabled').disabled,true);f.change({status:'stopped'});assert.equal(f.element('bots-enabled').disabled,false);});
test('Play waits for owned startup and never opens the game after failure',async()=>{
 const f=await rendererFixture();let ready;f.launcher.start=()=>new Promise(resolve=>ready=resolve);f.element('play').onclick();assert(f.element('play').disabled);assert.deepEqual(f.calls,[]);ready();await tick();assert.deepEqual(f.calls,[['client']]);
 f.calls.length=0;f.launcher.start=async()=>{throw Error('startup refused');};f.element('play').onclick();await tick();assert.deepEqual(f.calls,[]);assert.match(f.element('error').textContent,/startup refused/);
 f.change({status:'ready',clientURL:'http://127.0.0.1:47832/_runtime/'+'a'.repeat(64)+'/'});f.element('client-url').onclick({preventDefault(){}});await tick();assert.deepEqual(f.calls,[['client']]);assert.equal(f.element('client-url').textContent,'http://127.0.0.1:47832/');
});
test('home import only navigates to Accounts; import uses exported email and two independently revealable passwords',async()=>{
 const f=await rendererFixture();f.element('import').onclick();assert.equal(f.element('accounts-page').hidden,false);assert(!f.element('import-preview').open);await tick();
 let finish;f.change({operation:'Import player'});f.launcher.confirmImport=(...args)=>{f.calls.push(args);return new Promise(resolve=>finish=resolve);};
 f.element('accounts-import').onclick();await tick();assert(f.element('import-preview').open);assert.equal(f.element('local-login').textContent,metadata.login);assert.equal(f.element('replace-warning').hidden,false);assert.match(f.element('import-summary').textContent,/Guest1.*2 characters/);
 for(const id of ['import-password','import-confirmation'])assert.equal(f.element(id).type,'password');f.element('show-import-password').onclick();assert.equal(f.element('import-password').type,'text');assert.equal(f.element('import-confirmation').type,'password');f.element('show-import-password').onclick();assert.equal(f.element('import-password').type,'password');
 f.element('import-password').value=f.element('import-confirmation').value='custom-password';f.element('import-confirm').onclick();f.element('import-confirm').onclick();assert.deepEqual(f.calls,[[metadata.expected,'custom-password','custom-password',true]]);assert(f.element('import-cancel').disabled);
 finish({message:'Imported',login:metadata.login});await tick();assert(!f.element('import-preview').open);assert.equal(f.element('accounts-page').hidden,false);assert.equal(f.element('accounts-status').textContent,'Account imported.');assert.equal(f.element('import-password').value,'');assert(!f.elements.has('account-login'));
});
test('Escape cancels preview; failed consumed commit keeps its error without claiming cancellation',async()=>{
 const f=await rendererFixture();f.element('accounts-import').onclick();await tick();let prevented=false;f.element('import-preview').oncancel({preventDefault(){prevented=true;}});await tick();assert(prevented);assert(!f.element('import-preview').open);
 f.element('accounts-import').onclick();await tick();let reject;f.change({operation:'Import player'});f.launcher.confirmImport=()=>new Promise((_ok,bad)=>reject=bad);f.element('import-confirm').onclick();f.change({operation:undefined});reject(Error('Destination unchanged: backup permission denied'));await tick();assert(!f.element('import-preview').open);assert.match(f.element('error').textContent,/Destination unchanged/);assert.match(f.element('logs').textContent,/backup permission denied/);
});
test('restore cancellation leaves no home credential card and Close disables all mutations',async()=>{
 const f=await rendererFixture();f.launcher.listBackups=async()=>[{name:'first.sqlite',modified:1700000000000,bytes:42}];f.element('show-backups').onclick();await tick();assert.equal(f.element('backup-list').children.length,1);assert.equal(f.element('restore').disabled,false);
 f.launcher.restoreBackup=async name=>{f.calls.push(name);return undefined;};f.element('restore').onclick();await tick();assert.deepEqual(f.calls,['first.sqlite']);assert(!f.elements.has('imported-account'));
 f.change({closing:true,operation:'Import player'});for(const id of ['play','start','stop','client','accounts-import','backup','folder','restore','restore-other','save-folder'])assert(f.element(id).disabled,id);assert(!f.element('import-preview').open);
});
