import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('Windows metadata report cannot collide with the single updater journey result in promotion artifacts',async()=>{
 const script=await readFile('scripts/windows-metadata-test.mjs','utf8'),workflow=await readFile('.github/workflows/runtime-updates-test.yml','utf8'),promote=await readFile('scripts/promote-runtime.mjs','utf8');assert(script.includes("join(out,'windows-metadata-publication.json')"));assert(!script.includes("join(out,'result.json')"));assert(workflow.includes('.qa/windows-metadata/run-*/*.json'));assert(promote.includes("assert.equal(reports.length,1,'Exactly one native journey result required')"));
 const entries=['artifact/.qa/windows-metadata/run-native/windows-metadata-publication.json','artifact/.qa/runtime-updates/run-native/result.json'];assert.deepEqual(entries.filter(path=>path.endsWith('/result.json')||path.endsWith('\\result.json')),[entries[1]]);
});

test('Windows metadata native Rust and CLI gates use exact new pin, one-pass test and owned per-child receipt path',async()=>{
 const producer=await readFile('scripts/ci-runtime-inputs.mjs','utf8'),workflow=await readFile('.github/workflows/runtime-updates-test.yml','utf8'),pins=JSON.parse(await readFile('source-pins.json')),caps=JSON.parse(await readFile('runtime-capabilities.json'));assert.equal(pins.server.commit,'2c700135d755a4210c2204334aafee2572205ec1');assert.equal(caps.server,pins.server.commit);assert.equal(caps.desktopMetadata,1);assert(producer.includes('desktop_metadata_windows_file_container_generation_and_failures'));assert(producer.includes("command[1]='test'"));assert(producer.includes("output.includes(name+' ... ok')"));assert(producer.includes("await mkdir(caseOut);const output=execFileSync('python',['examples/testing/desktop-metadata-windows.py','--binary',binary]"));assert(producer.includes('env:{...process.env,QA_RESULTS_DIR:caseOut}'));assert(producer.includes('desktop-metadata-windows-result.json'));assert(workflow.includes('.qa/runtime-inputs/C/desktop-metadata-windows-cli/*.json'));
});
