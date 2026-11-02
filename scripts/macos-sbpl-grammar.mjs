import assert from 'node:assert/strict';
import {execFile,execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {macGrammarCase} from './macos-sbpl-grammar-case.mjs';
import {macOfflineCanaryResult,verifyMacOfflineCanary,persistMacOfflineEvidence} from './macos-offline-evidence.mjs';

assert(process.platform==='darwin'&&process.arch==='arm64'&&process.env.GITHUB_ACTIONS==='true','Grammar research requires an owned standard native ARM Mac CI VM');
const out=resolve('.qa/mac-sbpl-grammar'),policyPath=join(out,'case.sb');
const report={purpose:'ONE named compile/Node scope diagnostic, NOT production policy/browser/game acceptance',caseId:macGrammarCase.id,policy:macGrammarCase.policy,policySha256:createHash('sha256').update(macGrammarCase.policy).digest('hex'),sources:[],errors:[],status:'initializing'};
try{
  await mkdir(out,{recursive:true});await writeFile(policyPath,macGrammarCase.policy);
  report.head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',timeout:10000}).trim();report.system=execFileSync('/usr/bin/sw_vers',[],{encoding:'utf8',timeout:10000});
  for(const path of ['/usr/share/man/man1/sandbox-exec.1','/System/Library/Sandbox/Profiles/system.sb','/System/Library/Sandbox/Profiles/bsd.sb']){
    const source={path};report.sources.push(source);
    try{
      const bytes=await readFile(path);source.realpath=await realpath(path);source.sha256=createHash('sha256').update(bytes).digest('hex');
      const lines=bytes.toString('utf8').split('\n'),selected=new Set();
      lines.forEach((line,index)=>{if(/network|localhost|profile|configuration/i.test(line))for(let i=Math.max(0,index-2);i<=Math.min(lines.length-1,index+2);i++)selected.add(i);});
      source.passages=[...selected].sort((a,b)=>a-b).map(i=>({line:i+1,text:lines[i]}));
    }catch(error){source.error={code:error.code,message:error.message};}
  }
  report.compileCommand=['/usr/bin/sandbox-exec','-f',policyPath,process.execPath,'-e','console.log(JSON.stringify({compiled:true,pid:process.pid,executable:process.execPath}))'];
  report.compileProcess=await execute(report.compileCommand);assert.equal(report.compileProcess.error,null,'Candidate compile/owned Node execution failed');assert.equal(report.compileProcess.exitCode,0);report.compileProof=JSON.parse(report.compileProcess.stdout);assert.equal(report.compileProof.compiled,true);
  report.nodeCommand=['/usr/bin/sandbox-exec','-f',policyPath,process.execPath,resolve('scripts/macos-sbpl-grammar-canary.mjs'),policyPath];
  report.nodeProcess=await execute(report.nodeCommand);
  if(report.nodeProcess.stdout)try{report.nodeProof=JSON.parse(report.nodeProcess.stdout);}catch(error){report.nodeParseError=String(error);}
  verifyMacOfflineCanary(report.nodeProcess,report.policySha256);report.status='passed-node-scope-only';
}catch(error){report.errors.push(String(error.stack??error));report.status='failed';process.exitCode=1;}
finally{if(!await persistMacOfflineEvidence(report,join(out,'result.json')))process.exitCode=1;console.log(JSON.stringify(report,null,2));}
function execute(command){return new Promise(ok=>execFile(command[0],command.slice(1),{encoding:'utf8',timeout:20000},(error,stdout,stderr)=>ok(macOfflineCanaryResult(error,stdout,stderr))));}
