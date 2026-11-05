import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,symlink,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {windowsPowerShellExecutable} from '../scripts/native-boundaries.mjs';
import {assertWindowsInstallerWriteDenied} from '../scripts/installer-write-probe.mjs';

const engine=process.platform==='win32'?windowsPowerShellExecutable():process.env.OPENROTMG_TEST_POWERSHELL;
const skip=!engine?'Explicit portable/native PowerShell engine not supplied':false;
const source=resolve('scripts/installer-write-probe.ps1'),fixture=resolve('tests/fixtures/installer-probe-path.ps1');
const args=legacy=>['-NoProfile','-NonInteractive','-File',fixture,'-Source',source,...(legacy?['-ForceLegacyConsole']:[])];
async function owned(){await mkdir('.qa/unit',{recursive:true});const out=await mkdtemp(resolve('.qa/unit/probe-path-')),root=join(out,'installed Open RotMG é 日本'),runtime=join(root,'app-0.1.0/resources/runtime');await mkdir(runtime,{recursive:true});return {out,root,runtime};}
function input(directories){return JSON.stringify({directories,probeName:'installer-write-probe-00000000-0000-0000-0000-000000000000'});}
function roundTrip(value,text){assert.equal(value.transport.inputCodePage,65001);assert.equal(value.transport.outputCodePage,65001);assert.equal(value.transport.inputRedirected,true);assert.equal(value.transport.outputRedirected,true);assert.equal(value.transport.requestUtf8Base64,Buffer.from(text,'utf8').toString('base64'));assert.deepEqual(value.transport.decodedDirectories,JSON.parse(text).directories);}

test('actual Node UTF8 pipe to PowerShell -File round-trips nonASCII owned paths with default and forced1252 initial encodings',{skip},async()=>{
 const {root,runtime}=await owned(),text=input([root,runtime]);
 for(const legacy of [false,true]){
  const value=JSON.parse(execFileSync(engine,args(legacy),{input:text,encoding:'utf8',timeout:30000}));roundTrip(value,text);assert.equal(value.status,'paths-checked');assert.equal(value.portableOnly,true);assert.deepEqual(value.probes,[]);
  if(legacy){assert.equal(value.transport.inputBefore,1252);assert.equal(value.transport.outputBefore,1252);}
  for(const [index,check] of value.directoryChecks.entries()){assert.equal(check.directory,[root,runtime][index]);assert.equal(check.utf8Base64,Buffer.from(check.directory,'utf8').toString('base64'));assert.equal(check.provider.directory,true);assert.equal(check.provider.reparse,false);assert.equal(check.nativeMetadata.directory,true);}
 }
});
test('actual PowerShell missing-path failure retains decoded UTF8/provider/native context through the existing Node diagnostic wrapper',{skip},async()=>{
 const {out,root}=await owned(),missing=join(root,'missing é 日本');let calls=0;
 await assert.rejects(assertWindowsInstallerWriteDenied(root,missing,out,'install',engine,(_engine,_args,options)=>{
  calls++;return execFileSync(engine,args(true),options);
 }),error=>{
  const diagnostic=error.windowsWriteProbe,value=diagnostic.result;assert.equal(diagnostic.status,'failed');assert.equal(diagnostic.error.status,1);roundTrip(value,JSON.stringify(diagnostic.request));assert.equal(value.status,'failed');assert.equal(value.stage,'path-lookup');assert.equal(value.directoryChecks.length,2);assert.equal(value.directoryChecks[0].provider.directory,true);
  const failed=value.directoryChecks[1];assert.equal(failed.directory,missing);assert(failed.providerError.id.includes('PathNotFound'));assert(failed.nativeMetadata.errorType);assert.equal(value.sid,undefined);assert.deepEqual(value.probes,[]);return true;
 });
 assert.equal(calls,1);const saved=JSON.parse(await readFile(join(out,'windows-write-probe-install.json'),'utf8'));assert.equal(saved.result.transport.inputBefore,1252);assert.equal(saved.result.directoryChecks[1].directory,missing);
});
test('actual portable PowerShell directory checks reject real files/reparse points and malformed UTF8 without native permission execution',{skip},async()=>{
 const {out,root,runtime}=await owned(),file=join(out,'ordinary file é 日本');await writeFile(file,'owned path fixture');const cases=[file];
 if(process.platform!=='win32'){const link=join(out,'directory link é 日本');await symlink(root,link,'dir');cases.push(link);}
 for(const path of cases){
  let result;try{execFileSync(engine,args(false),{input:input([path,runtime]),encoding:'utf8',timeout:30000});assert.fail('Non-physical directory accepted');}catch(error){assert.equal(error.status,1);result=JSON.parse(error.stdout);}
  assert.equal(result.status,'failed');assert.match(result.failure.message,/real installed directory/);assert(result.directoryChecks[0].providerError);assert.deepEqual(result.probes,[]);
 }
 try{execFileSync(engine,args(true),{input:Buffer.from([0x7b,0xc3,0x28]),encoding:'utf8',timeout:30000});assert.fail('Invalid UTF8 accepted');}catch(error){assert.equal(error.status,1);const value=JSON.parse(error.stdout);assert.equal(value.stage,'input');assert.equal(value.transport.inputCodePage,65001);assert.equal(value.transport.requestUtf8Base64,undefined);assert.deepEqual(value.directoryChecks,[]);}
});
