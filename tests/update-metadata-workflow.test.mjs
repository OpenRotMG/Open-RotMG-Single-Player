import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('Windows metadata report cannot collide with the single updater journey result in promotion artifacts',async()=>{
 const script=await readFile('scripts/windows-metadata-test.mjs','utf8'),workflow=await readFile('.github/workflows/runtime-updates-test.yml','utf8'),promote=await readFile('scripts/promote-runtime.mjs','utf8');assert(script.includes("join(out,'windows-metadata-publication.json')"));assert(!script.includes("join(out,'result.json')"));assert(workflow.includes('.qa/windows-metadata/run-*/*.json'));assert(promote.includes("assert.equal(reports.length,1,'Exactly one native journey result required')"));
 const entries=['artifact/.qa/windows-metadata/run-native/windows-metadata-publication.json','artifact/.qa/runtime-updates/run-native/result.json'];assert.deepEqual(entries.filter(path=>path.endsWith('/result.json')||path.endsWith('\\result.json')),[entries[1]]);
});
