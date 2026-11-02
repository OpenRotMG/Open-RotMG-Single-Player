import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdir,open,readFile,writeFile} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {nativeServerBuild} from './native-server-build.mjs';
import {sha256} from './assets.mjs';

export const purpose='Focused native Windows terrain path regressions; packaged startup/health/stop/failure ownership is a separate required step. NOT game, graphics, offline or all-platform acceptance.';
export const serverCommit='850968f05358edbc89fa1af535e1a08bfd5b1f58';
const prepareSha256='8016da840a8da143dbabe81b4564fff2882e3dbccf82f8b542e3a875e2f1a953';
export const requiredTests=[
  'strict_source_portable_keys',
  'strict_source_host_root_spellings',
  'strict_source_reviewed_recipe_catalog',
  'strict_source_windows_drive_prefix_and_forward_slash_key',
  'strict_source_rejects_linked_inputs_and_root_ancestors',
].map(name=>`terrain::prepare::source_path_tests::${name}`);

export function windowsPrepareTestCommand(source,receipt) {
  assert.equal(receipt.platform,'win32','Native Windows build receipt required');
  assert.equal(receipt.arch,'x64','Native Windows x64 build receipt required');
  assert.equal(receipt.head,serverCommit,'Explicit reviewed Windows path candidate required');
  assert.equal(receipt.dirty,false,'Clean committed server source required');
  assert.deepEqual(receipt.command,nativeServerBuild(source,'win32','x64').command,'Test must reuse actual native release/static MSVC build flags');
  const command=[...receipt.command];command[1]='test';
  return [...command,'terrain::prepare','--','--nocapture'];
}
export function assertWindowsPrepareResults(output) {
  for(const name of requiredTests)assert(output.split(/\r?\n/).includes(`test ${name} ... ok`),`Required native regression did not pass: ${name}`);
  assert(/test result: ok\. 12 passed; 0 failed; 0 ignored; 0 measured; \d+ filtered out;/.test(output),'Expected all 12 candidate terrain::prepare tests, not zero/ignored/filtered-only success');
}

async function main() {
  assert(process.env.GITHUB_ACTIONS==='true'&&process.platform==='win32'&&process.arch==='x64','Only run on an owned native Windows x64 GitHub runner, never the VPS');
  const out=resolve('.qa/windows-path-validation');await mkdir(out,{recursive:true});
  const report={status:'running',purpose,platform:process.platform,arch:process.arch,requiredTests};
  const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
  try {
    report.launcherSource={head:git(process.cwd(),'rev-parse','HEAD'),dirty:git(process.cwd(),'status','--porcelain','--untracked-files=no')!==''};
    const pins=JSON.parse(await readFile('source-pins.json','utf8'));report.pins=pins;
    assert.equal(pins.server.commit,serverCommit);
    assert(process.env.OPENROTMG_BUILD_INPUTS&&isAbsolute(process.env.OPENROTMG_BUILD_INPUTS),'Explicit ci-inputs receipt required');
    const input=JSON.parse(await readFile(process.env.OPENROTMG_BUILD_INPUTS,'utf8'));report.input=input;
    for(const key of ['serverSource','serverBinary','serverBuildReceipt'])assert(isAbsolute(input[key]),`Absolute ${key} required`);
    assert.equal(input.platform,process.platform);assert.equal(input.arch,process.arch);
    const receipt=JSON.parse(await readFile(input.serverBuildReceipt,'utf8'));report.buildReceipt=receipt;
    const command=windowsPrepareTestCommand(input.serverSource,receipt);report.command=command;report.cwd=input.serverSource;
    assert.equal(git(input.serverSource,'rev-parse','HEAD'),serverCommit);
    assert.equal(git(input.serverSource,'status','--porcelain','--untracked-files=no'),'');
    report.prepareSha256=sha256(await readFile(join(input.serverSource,'src/terrain/prepare.rs')));
    assert.equal(report.prepareSha256,prepareSha256,'Exact reviewed prepare.rs required');
    assert.equal(sha256(await readFile(input.serverBinary)),receipt.sha256,'Actual built server identity required');
    assert.equal(input.serverBinarySha256,receipt.sha256);
    report.stdout=join(out,'terrain-prepare.stdout.log');report.stderr=join(out,'terrain-prepare.stderr.log');
    await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));
    const stdout=await open(report.stdout,'wx'),stderr=await open(report.stderr,'wx');
    let result;
    try {result=spawnSync(command[0],command.slice(1),{cwd:input.serverSource,stdio:['ignore',stdout.fd,stderr.fd]});}
    finally {await stdout.close();await stderr.close();}
    report.exitCode=result.status;report.signal=result.signal;
    if(result.error)throw result.error;
    const output=await readFile(report.stdout,'utf8'),errors=await readFile(report.stderr,'utf8');
    console.log(output);console.error(errors);
    assert.equal(result.status,0,`Native terrain::prepare failed: code=${result.status}, signal=${result.signal}; see preserved stdout/stderr`);
    assertWindowsPrepareResults(output);
    assert.equal(git(input.serverSource,'status','--porcelain','--untracked-files=no'),'','Tests must leave tracked source/data unchanged');
    report.status='passed';
  } catch(error) {report.status='failed';report.error=String(error.stack??error);console.error(report.error);process.exitCode=1;}
  finally {await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
