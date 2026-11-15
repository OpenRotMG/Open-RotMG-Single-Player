import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp} from 'node:fs/promises';import {tmpdir,homedir} from 'node:os';import {join} from 'node:path';
import {explain,LaunchError,Journal,redact,report} from '../dist/diagnostics.js';
test('known launch refusals name the cause and a next step; unknown ones point to Discord with the real message',()=>{
 const blocked=explain(new LaunchError('openrotmg.exe',{code:'UNKNOWN'},{code:4551,message:'An Application Control policy has blocked this file.'}),'runtime:start');
 assert.equal(blocked.title,"Couldn't start the game");assert.match(blocked.said,/Application Control policy.*code 4551/);assert.match(blocked.next,/Smart App Control/);
 const odd=explain(new LaunchError('openrotmg.exe',{code:'UNKNOWN'},{code:87,message:'The parameter is incorrect.'}),'runtime:start');
 assert.match(odd.said,/"The parameter is incorrect\." \(code 87\)/);assert.match(odd.next,/Discord/);
 assert.match(explain(Object.assign(new Error('write failed'),{code:'ENOSPC'}),'save:backup').next,/disk is full/);
 assert.equal(explain(new Error('Server exited without verified shutdown: code=101'),'playing').title,'The game server stopped');
});
test('the journal survives rotation and reports redact home folders and emails',async()=>{
 const j=new Journal(await mkdtemp(join(tmpdir(),'journal-')));j.write('first',{path:join(homedir(),'x')});j.write('second');assert.equal(j.recent(5).length,2);
 const text=report({folder:join(homedir(),'game')},undefined,j,['login player@example.com']);assert(!text.includes(homedir()));assert.match(text,/<email>/);assert.match(text,/"event":"second"/);
 assert.equal(redact('a@b.co'),'<email>');
});
