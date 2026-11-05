import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {recovered} from './update-recovery-fixture.mjs';
import {select} from '../dist/update-store.js';

for(const wrong of ['pending','activity','marker','backup','selection','target','extra'])test(`update-restore-intent rejects immutable ${wrong} proof substitution`,async()=>{
 const f=await recovered(),r=structuredClone(f.receipt),intent=structuredClone(await f.fence.evidence(r.proof.intentSha256));
 if(wrong==='pending'){const p=await f.fence.evidence(intent.pendingSha256);p.id=randomUUID();intent.pendingSha256=await f.fence.remember(p);}if(wrong==='activity')intent.oldActivitySha256=f.sha;if(wrong==='marker')intent.markerSha256='e'.repeat(64);if(wrong==='backup')intent.backupSha256='f'.repeat(64);if(wrong==='selection')intent.selected=select(f.a);if(wrong==='target')intent.target='win32-x64';if(wrong==='extra')intent.foreign=true;
 r.proof.intentSha256=await f.fence.remember(intent);await assert.rejects(f.fence.lineage(await f.fence.remember(r)));await f.fence.requireClean(select(f.a));
});
