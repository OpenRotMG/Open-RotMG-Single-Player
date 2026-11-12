import test from 'node:test';
import assert from 'node:assert/strict';
import {rendererFixture,tick} from './renderer-fixture.mjs';
test('runtime versions show authenticated counts, never invent future counts or mistake playable readiness for latest',async()=>{
 const f=await rendererFixture();assert.match(f.element('update-installed').textContent,/source build/);assert.match(f.element('update-installed').textContent,/Server commit #2542 · Client commit #88/);
 f.update({phase:'ready',installed:{...f.installed,kind:'release'},message:'Native readiness checked'});assert.equal(f.element('update-message').textContent,'Ready.');
 f.update({message:'Matches the published server + client release.'});assert.equal(f.element('update-message').textContent,'Up to date.');
 f.update({available:{...f.installed,kind:'release',sequence:2,version:'future',server:'e'.repeat(40),client:'f'.repeat(40)}});assert.match(f.element('update-available').textContent,/Server commit number unavailable · Client commit number unavailable/);
 f.update({available:{...f.installed,version:'future',server:'e'.repeat(40),client:'f'.repeat(40),serverCount:3000,clientCount:90}});assert.match(f.element('update-available').textContent,/Server commit #3000 · Client commit #90/);
});
test('pending preparation uses Play while both UI and named Start preserve startup/recovery guards',async()=>{
 const f=await rendererFixture();f.update({phase:'staged',message:'Authenticated runtime selected; guarded startup pending',canManageSaves:false,needsStart:true});
 for(const id of ['import','backup','folder','restore','restore-other'])assert(f.element(id).disabled,id);assert.equal(f.element('play').disabled,false);assert.match(f.element('message').textContent,/Play will prepare/);assert.doesNotMatch(f.element('message').textContent,/STAGED|Authenticated|guarded|runtime/);assert.match(f.element('logs').textContent,/guarded startup pending/);
 f.element('play').onclick();await tick();assert.deepEqual(f.calls,[['start'],['client']]);
 f.update({phase:'recovery',canRecover:true,needsStart:false});assert(f.element('play').disabled);assert.equal(f.element('home-recovery').hidden,false);f.change({status:'failed',pid:42});assert(f.element('home-recovery').disabled);assert(f.element('recover-runtime').disabled);
});
test('service refusal is explicit installed-version Play, with technical details only under Logs',async()=>{
 const f=await rendererFixture();f.update({phase:'service',message:'Runtime service HTTP 503; not offline',canPlayInstalled:true});assert.match(f.element('update-message').textContent,/Could not check/);assert.match(f.element('logs').textContent,/HTTP 503/);assert.equal(f.element('play').textContent,'Play installed game');f.element('play').onclick();await tick();assert.deepEqual(f.calls,[['installed'],['client']]);
 f.change({status:'stopped',operation:'Import player'});for(const id of ['check-updates','play-installed','retry-update','recover-runtime'])assert(f.element(id).disabled,id);
});
test('launcher update and signed game update controls stay separate; guarded retry and fixed releases action remain available',async()=>{
 const f=await rendererFixture();f.launcher.checkLauncher=async()=>({installed:'0.1.3',available:'0.1.4',phase:'available',message:'Launcher update available'});f.launcher.downloadLauncher=async()=>f.calls.push(['download-launcher']);
 f.update({phase:'service',message:'Game HTTP 503',canPlayInstalled:true});f.element('check-launcher').onclick();await tick();assert.equal(f.element('launcher-version').textContent,'0.1.3');assert.equal(f.element('download-launcher').hidden,false);assert.equal(f.element('launcher-update-steps').hidden,false);assert.match(f.element('logs').textContent,/Game HTTP 503/);
 f.element('download-launcher').onclick();await tick();assert.deepEqual(f.calls,[['download-launcher']]);
 f.update({phase:'launcher',canPlayInstalled:true});assert.equal(f.element('runtime-releases').hidden,false);f.element('runtime-releases').onclick();await tick();assert.deepEqual(f.calls.at(-1),['releases']);
 f.update({phase:'rejected',canRetry:true});f.element('retry-update').onclick();await tick();assert.deepEqual(f.calls.at(-1),['retry']);
});
test('Advanced logs search and problems filter retain actual failures, not only the current friendly status',async()=>{
 const f=await rendererFixture();f.change({logs:['INFO durable shutdown','WARN startup unverified event=guard.receipt']});f.element('log-search').value='guard.receipt';f.element('log-search').oninput();assert.match(f.element('logs').textContent,/guard.receipt/);assert.doesNotMatch(f.element('logs').textContent,/durable shutdown/);
 f.element('log-search').value='';f.element('log-filter').value='problems';f.element('log-filter').onchange();assert.match(f.element('logs').textContent,/unverified/);assert.doesNotMatch(f.element('logs').textContent,/durable shutdown/);
});
