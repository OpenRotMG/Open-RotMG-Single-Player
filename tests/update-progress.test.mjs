import test from 'node:test';
import assert from 'node:assert/strict';
import {UpdateReporter,progressText} from '../dist/update-progress.js';
import {rendererFixture,tick} from './renderer-fixture.mjs';

test('update progress counts actual bytes/files, preserves stage timing and logs bounded milestones',t=>{
 let now=1000;t.mock.method(Date,'now',()=>now);const views=[],logs=[],r=new UpdateReporter(v=>views.push(v),v=>logs.push(v));r.report('Download',0,100,'bytes');for(let n=1;n<=100;n++){now+=20;r.report('Download',n,100,'bytes');}assert.equal(r.value.completed,100);assert.equal(r.value.startedAt,1000);assert(views.length<20);assert(logs.length<15);assert.match(logs.at(-1),/100%/);assert.match(progressText(r.value,now+4000),/last progress 4s ago/);r.report('Hashing',0,5,'files');assert.equal(r.value.startedAt,now);assert.match(progressText(r.value),/0 \/ 5 files/);r.reset();assert.equal(r.value,undefined);
});
test('renderer shows measured update stage and percentage, and copies logs during an active download',async()=>{
 const f=await rendererFixture();f.launcherChange({installed:'1.0.0',phase:'downloading',message:'Downloading launcher · 25% (25.0 / 100.0 MB)',progress:{step:'Downloading launcher',completed:25,total:100,unit:'bytes',startedAt:Date.now()-1000,updatedAt:Date.now()}});assert.match(f.element('launcher-update-message').textContent,/25%/);assert.equal(f.element('launcher-progress').value,25);assert.equal(f.element('launcher-progress').max,100);assert.equal(f.element('launcher-progress').hidden,false);assert.equal(f.element('play').disabled,true);assert.equal(f.element('check-launcher').disabled,true);f.element('copy-logs').onclick();await tick();assert.equal(f.calls.at(-1)[0],'copy');assert.equal(f.element('copy-result').textContent,'Log copied.');f.element('tab-backups').onclick();await tick();assert.equal(f.element('error').textContent,'');
});

test('plain-data busy notices render as neutral status without polluting technical logs',async()=>{const f=await rendererFixture();f.launcher.minimize=async()=>{throw Object.freeze({name:'Notice',message:'The launcher is updating. Please wait.'});};f.element('minimize').onclick();await tick();assert.equal(f.element('error').getAttribute('role'),'status');assert.equal(f.element('error').getAttribute('class'),'notice info');assert.equal(f.element('error').textContent,'The launcher is updating. Please wait.');assert(!f.element('logs').textContent.includes('[object Object]'));});
