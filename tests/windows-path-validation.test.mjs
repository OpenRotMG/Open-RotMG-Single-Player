import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {nativeServerBuild} from '../scripts/native-server-build.mjs';
import {windowsPrepareTestCommand,assertWindowsPrepareResults,requiredTests,serverCommit,purpose,assertWindowsPackagedBuild,assertWindowsPackagedProcess} from '../scripts/windows-path-validation.mjs';
import {sha256} from '../scripts/assets.mjs';

const source=resolve('.qa/ci-inputs/server');
const receipt={platform:'win32',arch:'x64',head:serverCommit,dirty:false,command:nativeServerBuild(source,'win32','x64').command};
const passing=requiredTests.map(name=>`test ${name} ... ok`).join('\r\n')+'\r\ntest result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 515 filtered out; finished in 1.0s\r\n';

test('windows-path-validation derives test flags from actual native build receipt without target/profile/CRT drift',()=>{
  assert.deepEqual(windowsPrepareTestCommand(source,receipt),['cargo','test','--locked','--release','--target','x86_64-pc-windows-msvc','--config','target.x86_64-pc-windows-msvc.rustflags=["-C","target-feature=+crt-static"]','terrain::prepare','--','--nocapture']);
  for(const change of [{platform:'linux'},{arch:'arm64'},{head:'f73676768ff9fbb635eac9680a3fdc9a0739d178'},{dirty:true},{command:['cargo','build','--release']},{command:receipt.command.filter(value=>value!=='--release')}])assert.throws(()=>windowsPrepareTestCommand(source,{...receipt,...change}));
});
test('windows-path-validation requires actual passed Windows drive/key, linked-input junction and 13-recipe catalog tests',()=>{
  assert.doesNotThrow(()=>assertWindowsPrepareResults(passing));
  for(const name of requiredTests) {
    assert.throws(()=>assertWindowsPrepareResults(passing.replace(`test ${name} ... ok`,'')),/Required native regression/);
    assert.throws(()=>assertWindowsPrepareResults(passing.replace(`test ${name} ... ok`,`test ${name} ... ignored`)),/Required native regression/);
  }
  for(const output of ['', 'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 527 filtered out;',passing.replace('12 passed','11 passed'),passing.replace('0 failed','1 failed')])assert.throws(()=>assertWindowsPrepareResults(output));
});
test('windows-path-validation binds copied binary and package generation to exact verified source/build receipt',async()=>{
  const pins={
    server:{repository:'https://github.com/dginovker/Open-RotMG-Server',commit:serverCommit,dataSha256:'457afcb2ed6eef68c28b6d3c0020f8fa9c2ecf2b4bcbae6db12eea17b68d3bf3',upstream:'https://github.com/OpenRotMG/Open-RotMG-Server'},
    client:{repository:'https://github.com/dginovker/Open-RotMG-Client',commit:'b80476c7f0fd9136c1b35f52a724ea50b4c3502b',preparedSha256:'f27939dba025464f57ab33c4029f43ac7ccf56d4f31777a9061df3beaa35e808',upstream:'https://github.com/OpenRotMG/Open-RotMG-Client'},
    ruffle:{version:'0.7.1-openrotmg.16',sourceCommit:'89a7049965f3090e706265670df309a5128233ac',bundleSha256:'579236cd5a97edd3ee82c82e7e6c96976178bdc8941bfb2a64b6693f05160435'},
  };
  const binarySha256=sha256('actual installed server bytes'),receiptBytes=Buffer.from(JSON.stringify({...receipt,sha256:binarySha256}));
  const build={platform:'win32',arch:'x64',pins,binarySha256,buildReceiptSha256:sha256(receiptBytes),assetsSha256:sha256('verified package assets')};
  const fixture={pins,build,generatedBuild:structuredClone(build),input:{platform:'win32',arch:'x64',serverSource:source,serverBinarySha256:binarySha256},receiptBytes,binarySha256};
  assert.doesNotThrow(()=>assertWindowsPackagedBuild(fixture));
  for(const field of ['pins','binarySha256','buildReceiptSha256','platform','arch']) {
    const wrong={...fixture,build:structuredClone(build)};wrong.build[field]=field==='pins'?{server:{commit:'wrong'}}:'wrong';
    assert.throws(()=>assertWindowsPackagedBuild(wrong),/Copied build identity/);
  }
  assert.throws(()=>assertWindowsPackagedBuild({...fixture,binarySha256:sha256('wrong server')}),/Copied installed server/);
  assert.throws(()=>assertWindowsPackagedBuild({...fixture,generatedBuild:{...build,assetsSha256:sha256('other generation')}}),/package generation/);
  const wrongPins={...pins,server:{...pins.server,commit:'f73676768ff9fbb635eac9680a3fdc9a0739d178'}};
  assert.throws(()=>assertWindowsPackagedBuild({...fixture,pins:wrongPins}),/Reviewed Windows source/);
  assert.throws(()=>assertWindowsPackagedBuild({...fixture,build:{...build,pins:wrongPins},generatedBuild:{...build,pins:wrongPins}}),/Copied source\/data\/client/);
  assert.throws(()=>assertWindowsPackagedBuild({...fixture,receiptBytes:Buffer.from(JSON.stringify({...receipt,sha256:binarySha256,rustc:'other compiler generation'}))}),/verified native receipt/);
  assert.throws(()=>assertWindowsPackagedBuild({...fixture,input:{...fixture.input,serverBinarySha256:sha256('wrong input')}}),/Native input binary/);
});
test('windows-path-validation rejects wrong actual Windows image or PID generation even when argv names installed binary',()=>{
  const binary='D:\\qa\\installed runtime with spaces\\resources\\runtime\\openrotmg.exe';
  const identity={pid:123,executable:binary,started:'2026-11-02T15:00:01.1234567Z',argv:`"${binary}" --desktop --config D:\\state\\desktop-config.json`};
  const launcherHead='24f30f57dda70e1890e64fe94096295e0812b5fe';
  const expected={pid:123,binary,requestedAt:Date.parse('2026-11-02T15:00:00Z'),observedAt:Date.parse('2026-11-02T15:00:02Z'),health:{process:123,revision:launcherHead},launcherHead};
  assert.doesNotThrow(()=>assertWindowsPackagedProcess(identity,expected));
  assert.doesNotThrow(()=>assertWindowsPackagedProcess({...identity,executable:binary.toUpperCase()},expected));
  assert.throws(()=>assertWindowsPackagedProcess(identity,{...expected,health:{...expected.health,process:456}}),/Health must belong/);
  assert.throws(()=>assertWindowsPackagedProcess(identity,{...expected,health:{...expected.health,revision:serverCommit}}),/launcher build generation/);
  for(const change of [{executable:'D:\\other\\openrotmg.exe'},{executable:binary+'.other.exe'},{executable:null},{pid:456},{started:'2026-11-02T14:59:59Z'},{started:'2026-11-02T15:00:03Z'},{started:'invalid'}])assert.throws(()=>assertWindowsPackagedProcess({...identity,...change},expected));
});
test('Phase5 paired runtime pins are exact and cannot inherit historical Windows qualification',async()=>{
  const pins=JSON.parse(await readFile('source-pins.json','utf8'));
  assert.deepEqual(pins,{
    server:{repository:'https://github.com/dginovker/Open-RotMG-Server',commit:'6e6e6801f61ae030437d6c6ed69dec9082409cb0',dataSha256:'1d760c221a69e3f4e55dd8d32fa2698a9df04ec1f02d9095356897ae13aba1b4',upstream:'https://github.com/OpenRotMG/Open-RotMG-Server'},
    client:{repository:'https://github.com/dginovker/Open-RotMG-Client',commit:'d3016983e6fa807be8bf700001e0ba2cf0fc2a7e',preparedSha256:'486c0bb640d3d398a443b598661dc1e5ad6ffe630159b8587258dee1aa6bbb71',upstream:'https://github.com/OpenRotMG/Open-RotMG-Client'},
    ruffle:{version:'0.7.1-openrotmg.16',sourceCommit:'89a7049965f3090e706265670df309a5128233ac',bundleSha256:'579236cd5a97edd3ee82c82e7e6c96976178bdc8941bfb2a64b6693f05160435'},
  });
  assert.throws(()=>assertWindowsPackagedBuild({pins,receiptBytes:Buffer.from('{}')}),/Reviewed Windows source/);
  assert.match(purpose,/NOT game, graphics, offline or all-platform acceptance/);
});
test('windows-path-validation workflow is manual standard native Windows and never downloads or launches a game browser',async()=>{
  const workflow=await readFile('.github/workflows/windows-path-validation.yml','utf8');
  assert.match(workflow,/workflow_dispatch:/);assert.match(workflow,/runs-on: windows-2022/);
  assert.match(workflow,/contents: read/);assert.match(workflow,/name: windows-path-focused-validation/);
  const commands=['node scripts/ci-inputs.mjs','node scripts/windows-path-validation.mjs','npm test && npm run package','node scripts/package-test.mjs --failure-tests-only'];
  let previous=-1;
  for(const command of commands){const index=workflow.indexOf(command);assert(index>previous,command);previous=index;}
  assert(!/playwright install|BROWSER_MODE|self-hosted|NoSandbox|no-sandbox|gpu|offline-probe|native-game/.test(workflow));
  assert.match(workflow,/if: always\(\)/);assert.match(workflow,/\.qa\/windows-path-validation\/\*\.log/);
});
for(const [fixtureName,lineEnding] of [['LF','\n'],['CRLF','\r\n']]) {
test(`package-test focused branch protects installation before first focused launch, reuses ready/health/stop/lock assertions, skips nativeGame and preserves rollback (${fixtureName} source fixture)`,async()=>{
  const code=(await readFile('scripts/package-test.mjs','utf8')).split(/\r?\n/).join(lineEnding);
  const protection=code.indexOf('restoreInstallation=await protectInstallation(packageDir);');
  assert(protection>0);assert.equal(code.match(/protectInstallation\(packageDir\)/g).length,1);
  assert.match(code.slice(0,protection),/if\(!failureTestsOnly\) \{\s*page = await launch\(\);[\s\S]*\r?\n    \}\r?\n    $/);
  const shared=code.slice(protection,code.indexOf('    if(!failureTestsOnly) {',protection));
  assert(shared.indexOf('assertInstallationProtected')<shared.indexOf('page=await launch()'));
  assert.match(shared,/test userData is owned outside install/);
  const focused=code.slice(code.indexOf('    if(failureTestsOnly) {'),code.indexOf(`    } else {${lineEnding}    const view = await start();`));
  for(const call of ['await start();','await rejectStateContender(','await stop();','shutdown persistence complete','await launcher.close();'])assert(focused.includes(call),call);
  assert(!/nativeGame|backup-fixture|\.mutate\(|\.verify\(/.test(focused));
  assert.match(code,/else \{\r?\n    const view = await start\(\);[\s\S]*const game = await nativeGame/);
  assert.match(code,/await failureCloseTests\(\{out,native,env:consumerEnv,check,report,observeLauncher,onReady:observeServer\}\)/);
  assert.match(code,/chromiumSandbox: true, env:consumerEnv/);
  assert.match(code,/packagedChildReady[\s\S]*'packaged child readiness', 650000/);
  assert.match(code,/health\.process === serverPid/);
  assert.match(code,/const bindWindowsBuild=async\(\)=>\{[\s\S]*assertWindowsPackagedBuild\(binding\)/);assert.match(shared,/if\(failureTestsOnly&&process.platform==='win32'\) \{\s*report\.windowsFocusedBinding=await bindWindowsBuild\(\)/);
  assert(code.indexOf('assertWindowsPackagedBuild(binding)')<code.indexOf('    page=await launch();'));
  assert.match(code,/windowsProcessIdentity\(serverPid\)[\s\S]*assertWindowsPackagedProcess\(identity,\{pid:serverPid,binary,requestedAt,observedAt,health,launcherHead:report.launcherSource.head\}\)/);
  assert.match(focused,/assert\.deepEqual\(identity,readyIdentity/);
  assert.match(code,/finally \{[\s\S]*if\(restoreInstallation\)try\{await restoreInstallation\(\);/);
  assert.match(code,/NOT game, graphics, offline or all-platform acceptance/);
});
}
