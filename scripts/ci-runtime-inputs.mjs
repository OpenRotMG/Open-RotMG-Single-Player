import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,copyFile,chmod,readdir,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {assembleRuntime,archiveRuntime} from './runtime-payload.mjs';
import {nativeServerBuild} from './native-server-build.mjs';
import {hashFile,targetName} from '../dist/update-format.js';

assert.equal(process.env.GITHUB_ACTIONS,'true','This producer is only for a dedicated native hosted runner; VPS uses its existing owned input clones/fair managed Cargo');
const target=targetName(),root=resolve('.qa/runtime-inputs'),server=join(root,'server'),client=join(root,'client');await mkdir(root,{recursive:true});
const run=(file,args,cwd)=>execFileSync(file,args,{cwd,encoding:'utf8',maxBuffer:64*1024*1024});
const pins=JSON.parse(await readFile('source-pins.json')),capabilities=JSON.parse(await readFile('runtime-capabilities.json'));assert.equal(capabilities.server,pins.server.commit);
// The legacy migration donor must not inherit newer candidate data, runtime or display metadata.
const a={
 server:{repository:'https://github.com/OpenRotMG/Open-RotMG-Server',upstream:'https://github.com/OpenRotMG/Open-RotMG-Server',commit:'ec2cd6b0e9b0891b8f1bc6dca71c1cc9312c2a7c',dataSha256:'1d760c221a69e3f4e55dd8d32fa2698a9df04ec1f02d9095356897ae13aba1b4'},
 client:{repository:'https://github.com/OpenRotMG/Open-RotMG-Client',upstream:'https://github.com/OpenRotMG/Open-RotMG-Client',commit:'b80476c7f0fd9136c1b35f52a724ea50b4c3502b',preparedSha256:'f27939dba025464f57ab33c4029f43ac7ccf56d4f31777a9061df3beaa35e808'},
 ruffle:{version:'0.7.1-openrotmg.16',sourceCommit:'89a7049965f3090e706265670df309a5128233ac',bundleSha256:'579236cd5a97edd3ee82c82e7e6c96976178bdc8941bfb2a64b6693f05160435'}
};
for(const[path,repo]of[[server,pins.server.repository],[client,pins.client.repository]])run('git',['-c','core.autocrlf=false','clone','--no-checkout',repo+'.git',path]);
const receipts={};for(const[label,source]of[['A',a],['C',pins]]){
 const out=join(root,label);await mkdir(out);for(const[path,head]of[[server,source.server.commit],[client,source.client.commit]]){run('git',['fetch','origin',head],path);run('git',['-c','core.autocrlf=false','checkout','--detach',head],path);assert.equal(run('git',['status','--porcelain','--untracked-files=no'],path).trim(),'');}
 run(process.platform==='win32'?'python':'python3',['scripts/run.py','--prepare-only'],client);
 const build=nativeServerBuild(server,process.platform,process.arch);const stdout=run(build.command[0],build.command.slice(1),server);await writeFile(join(out,'build.log'),stdout);const binary=join(out,process.platform==='win32'?'openrotmg.exe':'openrotmg');await copyFile(build.binary,binary);await chmod(binary,0o755);
 const receipt={head:source.server.commit,tree:run('git',['rev-parse','HEAD^{tree}'],server).trim(),dirty:false,sha256:await hashFile(binary),sourceRoot:server,origin:source.server.repository,command:build.command,rustc:run('rustc',['-Vv'],server),platform:process.platform,arch:process.arch};await writeFile(join(out,'server-artifact.json'),JSON.stringify(receipt,null,2)+'\n');
 const input={serverSource:server,serverBinary:binary,serverBinarySha256:receipt.sha256,serverBuildReceipt:join(out,'server-artifact.json'),clientSource:client,preparedClient:client,platform:process.platform,arch:process.arch};await writeFile(join(out,'build-inputs.json'),JSON.stringify(input,null,2)+'\n');await assembleRuntime(input,source,join(out,'runtime'),{startupBackup:label==='C'?1:0,clientNamespace:label==='C'?1:0,desktopMetadata:label==='C'?capabilities.desktopMetadata:undefined,accountManagement:label==='C'?capabilities.accountManagement:undefined,save:label==='C'?capabilities.save:{cli:1,read:[21,22],write:22,startupBackup:0}});receipts[label]=input;
 if(label==='C'){
  const names=['local_edits_keep_other_accounts_and_progress_and_reject_stale_or_duplicate_names','separate_operational_state_is_explicit_distinct_and_desktop_only','startup_backup_publication_and_flush_failures_abort_main_before_migration_or_listening','startup_backup_schema21_22_and_23_are_verified_unconditional_and_keep_credentials',...(process.platform==='win32'?['windows_startup_backup_durable_publication_consumes_staging_and_never_replaces','desktop_metadata_windows_file_container_generation_and_failures']:[])];
  for(const name of names){const command=[...build.command];command[1]='test';command.push(name,'--','--nocapture');const output=run(command[0],command.slice(1),server);await writeFile(join(out,name+'.log'),output);assert(output.includes(name+' ... ok')&&/test result: ok\. 1 passed; 0 failed/.test(output),'Required actual native Rust regression did not pass: '+name);}
  if(process.platform==='win32'){const caseOut=join(out,'desktop-metadata-windows-cli');await mkdir(caseOut);const output=execFileSync('python',['examples/testing/desktop-metadata-windows.py','--binary',binary],{cwd:server,env:{...process.env,QA_RESULTS_DIR:caseOut},encoding:'utf8',maxBuffer:64*1024*1024});await writeFile(join(out,'desktop-metadata-windows-cli.log'),output);const result=JSON.parse(await readFile(join(caseOut,'desktop-metadata-windows-result.json')));assert.equal(result.binarySha256,receipt.sha256);assert(result.cases.length>0&&result.cases.every(c=>Number.isSafeInteger(c.process)&&c.process>0&&Number.isInteger(c.exit)));assert(result.ackFailure.exit!==0&&result.ackFailure.destinationPreserved&&result.ackFailure.sourceConsumed);}
 }
}
const c=join(root,'C'),archive=join(c,`runtime-${target}.tar.gz`),archiveInfo=join(c,'payload.json');await writeFile(archiveInfo,JSON.stringify(await archiveRuntime(join(c,'runtime'),archive,{startupBackup:1,clientNamespace:1}),null,2)+'\n');
await writeFile(join(root,'native-inputs.json'),JSON.stringify({A:join(root,'A/runtime'),C:join(c,'runtime'),archive,archiveInfo},null,2)+'\n');
await writeFile(join(root,'producer.json'),JSON.stringify({target,launcher:run('git',['rev-parse','HEAD']).trim(),sourcePair:pins,receipts,scope:'Fresh sequential native A/C builds in one clone pair. A notice0 is QA assembly, not the historical Linux byte identity; no promotion/signing.'},null,2)+'\n');
