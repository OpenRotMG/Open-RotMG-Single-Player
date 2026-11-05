import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

function assertPromotionConcurrency(workflow){
 const text=workflow.replace(/\r\n/g,'\n');
 assert.match(text,/^concurrency:\n  group: single-player-runtime-promotion\n  cancel-in-progress: false\n/m);assert(text.indexOf('\nconcurrency:')<text.indexOf('\njobs:'));
}
for(const ending of ['LF','CRLF'])test(`runtime promotion concurrency preserves strict workflow-wide exclusion with ${ending}`,async()=>{
 const text=(await readFile('.github/workflows/promote-runtime.yml','utf8')).replace(/\r\n/g,'\n'),encode=value=>ending==='CRLF'?value.replace(/\n/g,'\r\n'):value;
 assertPromotionConcurrency(encode(text));
 for(const changed of [text.replace('group: single-player-runtime-promotion','group: ${{ inputs.tag }}'),text.replace('cancel-in-progress: false','cancel-in-progress: true'),text.replace('concurrency:\n  group: single-player-runtime-promotion\n  cancel-in-progress: false','  concurrency:\n    group: single-player-runtime-promotion\n    cancel-in-progress: false')])assert.throws(()=>assertPromotionConcurrency(encode(changed)));
});

test('runtime-updates workflow requires the three standard native targets and no retired platform/security detours',async()=>{
 const code=await readFile('.github/workflows/runtime-updates-test.yml','utf8'),producer=await readFile('scripts/ci-runtime-inputs.mjs','utf8');assert.match(code,/workflow_dispatch:/);assert.match(code,/os: \[ubuntu-22\.04, windows-2022, macos-15\]/);assert.match(code,/contents: read/);assert.match(code,/npm run test:runtime-updates/);assert(!/self-hosted|intel|notar|no-sandbox|disable-gpu-driver|RUNTIME_MANIFEST_SIGNING_KEY/.test(code));
 assert.equal((producer.match(/core\.autocrlf=false/g)||[]).length,2,'Clone and each A/C checkout must preserve exact LF-bound data/client hashes on Windows');
 for(const name of ['windows_startup_backup_durable_publication_consumes_staging_and_never_replaces','startup_backup_publication_and_flush_failures_abort_main_before_migration_or_listening','startup_backup_schema21_and_22_are_verified_unconditional_and_keep_credentials'])assert(producer.includes(name));assert.match(producer,/command\[1\]='test'/);assert.match(producer,/output\.includes\(name\+' \.\.\. ok'\)/);assert.match(producer,/\['A',a\],\['C',pins\]/);
});
test('runtime-updates Linux offline gate reuses private loopback-only namespace, never host egress policy',async()=>{
 const wrapper=await readFile('scripts/offline-linux.mjs','utf8'),workflow=await readFile('.github/workflows/runtime-updates-test.yml','utf8'),driver=await readFile('scripts/runtime-updates-test.mjs','utf8'),promote=await readFile('scripts/promote-runtime.mjs','utf8');assert.match(wrapper,/runtimeUpdates\?'scripts\/runtime-updates-test.mjs':'scripts\/package-test.mjs'/);assert.match(wrapper,/ENETUNREACH/);assert.match(wrapper,/OPENROTMG_RUNTIME_UPDATE_OFFLINE_PROOF/);assert.match(workflow,/node scripts\/offline-linux.mjs --runtime-updates/);assert.match(driver,/proof.namespace,await readlink\('\/proc\/self\/ns\/net'\)/);assert.match(promote,/report.osOffline.probes/);assert(!/iptables|nft |networksetup|pfctl/.test(wrapper+workflow));
});
test('runtime promotion runs exact trusted-main validation and keeps private key out of candidate/native jobs',async()=>{
 const workflow=await readFile('.github/workflows/promote-runtime.yml','utf8'),code=await readFile('scripts/promote-runtime.mjs','utf8');assertPromotionConcurrency(workflow);assert.match(code,/requireAvailableRuntimeSequence\(/);assert.match(workflow,/if: github.ref == 'refs\/heads\/main'/);assert.match(workflow,/ref: \$\{\{ github.sha \}\}/);assert.equal((workflow.match(/secrets\.RUNTIME_MANIFEST_SIGNING_KEY/g)||[]).length,1);assert.match(workflow,/npm ci --ignore-scripts/);assert(!/checkout.*candidate|--clobber|release edit|draft=false/.test(workflow));assert.match(code,/assert.equal\(run.head_sha,head\)/);assert.match(code,/assert.equal\(report.launcherCandidate.dirty,false\)/);assert.match(code,/assert.equal\(run.conclusion,'success'\)/);assert.match(code,/createPublicKey\(key\).*MANIFEST_PUBLIC_KEY/);assert.match(code,/verifyManifest\(bytes,signature,MANIFEST_PUBLIC_KEY/);assert(!/spawn\(|execFileSync\(.*openrotmg|process\.env\.(?:PUBLIC_KEY|UPDATE_ORIGIN)/.test(code));
});
test('normal-cache native helper keeps routing disabled in declared cache mode and only uses page-local input',async()=>{
 const game=await readFile('scripts/native-game.mjs','utf8'),driver=await readFile('scripts/runtime-updates-test.mjs','utf8'),policy=await readFile('src/update-policy.ts','utf8');assert.match(game,/!normalCache\)await page.route/);assert.match(driver,/Network\.requestServedFromCache/);assert.match(driver,/Network\.responseReceivedExtraInfo/);assert.match(driver,/Network\.getResponseBody/);assert.match(driver,/normalCache:true/);for(const code of [game,driver])assert(!/bringToFront\(|Network\.setCacheDisabled|Network\.setOffline/.test(code));
 assert(!/process\.env/.test(policy));assert.match(policy,/5038|MCowBQYDK2VwAyEA/);
});
