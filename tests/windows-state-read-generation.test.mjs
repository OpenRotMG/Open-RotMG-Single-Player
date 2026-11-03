import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {windowsPowerShellExecutable} from '../scripts/native-boundaries.mjs';

for(const [name,eol] of [['LF','\n'],['CRLF','\r\n']])test(`windows-state-read-generation preserves raw typed proof and exact PID/UTC ticks before ACL (${name})`,async()=>{
  const fixture=async path=>{const text=(await readFile(path,'utf8')).replace(/\r\n/g,'\n').replace(/\n/g,eol);assert.equal(text.includes('\r\n'),name==='CRLF');return text.replace(/\r\n/g,'\n');};
  const helper=await fixture('scripts/windows-state-read-generation.ps1'),acl=await fixture('scripts/windows-state-read-acl.ps1');
  assert.match(helper,/rawSerialization=\(ConvertTo-Json -InputObject \$value/);assert.match(helper,/GetType\(\).FullName/);assert.match(helper,/DateTimeOffset/);assert.match(helper,/DateTimeKind\]::Unspecified/);assert.match(helper,/IsAmbiguousTime/);assert.match(helper,/IsInvalidTime/);assert.match(helper,/UtcDateTime.Ticks.ToString/);
  assert.match(helper,/\[uint64\]\$requested.pid -ne \[uint64\]\$observed.ProcessId -or \$proof.requested.birth.utcTicks -cne \$proof.observed.birth.utcTicks/);assert(!/TotalMilliseconds|Round\(|AddMilliseconds|DateKind.*Utc|SpecifyKind\(\$value,\[DateTimeKind\]::Utc/.test(helper));
  assert(acl.indexOf('$result.generationProof=')<acl.indexOf('$consumer=Get-CimInstance'));assert(acl.indexOf('Assert-StateReadGeneration')<acl.indexOf('GetOwnerSid'));assert(acl.indexOf('Assert-StateReadGeneration')<acl.indexOf('foreach($path in $request.paths)'));
  assert.match(acl,/AccessControlSections\]::Access/);assert.match(acl,/FileSystemRights\]1,/);
  const node=await fixture('scripts/windows-state-read-denied.mjs');assert.match(node,/'-File',script/);
});
test('windows-state-read-generation native PowerShell JSON DateTime and exact-type/precision rejection (LF+CRLF)',{skip:process.platform!=='win32'?'Native Windows PS7 unavailable locally; no parser/runtime pass claimed':false},async()=>{
  await mkdir('.qa/unit',{recursive:true});const out=await mkdtemp(resolve('.qa/unit/state-generation-')),source=(await readFile('scripts/windows-state-read-generation.ps1','utf8')).replace(/\r\n/g,'\n');
  for(const [name,eol] of [['LF','\n'],['CRLF','\r\n']]){
    const helper=join(out,name+'.ps1');await writeFile(helper,source.replace(/\n/g,eol));
    const output=execFileSync(windowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-File',resolve('tests/windows-state-read-generation.ps1'),'-Helper',helper],{encoding:'utf8',timeout:30000});await writeFile(join(out,name+'.json'),output);
    const report=JSON.parse(output);assert.equal(report.passed,23);assert.equal(report.serializationProof.match,true);assert.equal(report.serializationProof.requested.birth.utcTicks,report.serializationProof.observed.birth.utcTicks);assert.equal(report.aclOperations,false);assert.equal(report.consumerProcessQueries,false);
  }
});
