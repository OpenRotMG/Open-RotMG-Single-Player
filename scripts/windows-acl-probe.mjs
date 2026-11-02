import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,readFile,copyFile,appendFile,unlink,readdir,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {release} from 'node:os';
import {protectInstallation} from './native-boundaries.mjs';

assert(process.platform==='win32'&&process.arch==='x64'&&process.env.GITHUB_ACTIONS==='true','ACL diagnostics require an owned native Windows x64 CI VM');
const out=resolve('.qa/windows-acl-probe');await mkdir(out,{recursive:true});
const report={purpose:'Owned install ACL diagnostics, NOT package/game/clean-machine acceptance',head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),os:process.platform,arch:process.arch,release:release(),assertions:[],errors:[]};
const fixture=await mkdtemp(join(process.env.RUNNER_TEMP,'acl with spaces-'));report.fixture=fixture;
const nested=join(fixture,'nested directory'),program=join(nested,'owned-node.exe');let restore;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
try {
  await mkdir(nested);await copyFile(process.execPath,program);
  const source=await readFile(process.execPath);report.executable={source:process.execPath,copy:program,sha256:hash(source),bytes:source.length};assert.equal(hash(await readFile(program)),report.executable.sha256);
  const cases=[{name:'root',directory:fixture,file:join(fixture,'root-data.txt')},{name:'nested',directory:nested,file:join(nested,'nested-data.txt')}];
  for(const item of cases)await writeFile(item.file,item.name+' sentinel');
  restore=await protectInstallation(fixture);
  for(const item of cases){
    assert((await readdir(item.directory)).length>0);assert.equal(await readFile(item.file,'utf8'),item.name+' sentinel');report.assertions.push(item.name+':read/traverse allowed');
    for(const [operation,action] of [
      ['create-file',()=>writeFile(join(item.directory,'new-file.txt'),'forbidden')],
      ['create-directory',()=>mkdir(join(item.directory,'new-directory'))],
      ['overwrite',()=>writeFile(item.file,'forbidden')],
      ['append',()=>appendFile(item.file,'forbidden')],
      ['delete',()=>unlink(item.file)],
    ]){
      await assert.rejects(action,error=>['EACCES','EPERM'].includes(error.code),item.name+':'+operation+' must be denied');report.assertions.push(item.name+':'+operation+' denied');
    }
    assert.equal(await readFile(item.file,'utf8'),item.name+' sentinel');
  }
  assert.equal(execFileSync(program,['-e','process.stdout.write(process.version)'],{encoding:'utf8',timeout:10000,windowsHide:true}),process.version);
  assert.equal(hash(await readFile(program)),report.executable.sha256);report.assertions.push('unmodified copied Node executes through protected install with spaces');
  await restore();restore=undefined;report.rollbackCompleted=true;
  for(const item of cases){
    await writeFile(item.file,'restored');await appendFile(item.file,'!');assert.equal(await readFile(item.file,'utf8'),'restored!');await unlink(item.file);await writeFile(item.file,'rebuilt');
    const directory=join(item.directory,'restored-directory');await mkdir(directory);await rm(directory,{recursive:true});report.assertions.push(item.name+':create/overwrite/append/delete restored');
  }
  report.status='passed';
}catch(error){report.status='failed';report.errors.push(String(error.stack??error));console.error(report.errors.at(-1));process.exitCode=1;}
finally {
  if(restore)try{await restore();report.rollbackCompleted=true;}catch(error){report.errors.push(`ACL rollback: ${error}`);process.exitCode=1;}
  if(report.errors.length)report.status='failed';
  await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
