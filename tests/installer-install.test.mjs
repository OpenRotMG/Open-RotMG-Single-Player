import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {MakerZIP} from '@electron-forge/maker-zip';
import {installArtifact,writableOwnedInstallation} from '../scripts/installer-install.mjs';
import {protectInstallation,assertInstallationProtected} from '../scripts/native-boundaries.mjs';

test('installer-install extracts the actual Forge Linux ZIP into a protected non-ASCII path and replaces only installation on reinstall (unit content, not a production app)',{skip:process.platform!=='linux'},async()=>{
 await mkdir('.qa/unit',{recursive:true});const out=await mkdtemp(resolve('.qa/unit/installer-')),input=join(out,'Open RotMG Single Player-linux-x64'),root=join(out,'installed é 日本'),profile=join(out,'persistent profile');
 await mkdir(join(input,'resources'),{recursive:true});await mkdir(profile);await writeFile(join(profile,'save'),'persistent unit sentinel');await writeFile(join(input,'resources/unit'),'unit package content');
 const maker=new MakerZIP({},['linux']);
 const [artifact]=await maker.make({dir:input,makeDir:join(out,'make'),appName:'unit',packageJSON:{version:'0.0.0'},targetArch:'x64',targetPlatform:'linux'});
 await installArtifact(artifact,root,out);assert.equal(await readFile(join(root,'resources/unit'),'utf8'),'unit package content');
 await protectInstallation(root);assert.equal((await stat(join(root,'resources/unit'))).mode&0o222,0);
 if(process.getuid()!==0)await assertInstallationProtected(root,join(root,'resources'));
 await writableOwnedInstallation(root);await writeFile(join(root,'stale'),'unit stale file');
 await installArtifact(artifact,root,out,true);await assert.rejects(stat(join(root,'stale')),error=>error.code==='ENOENT');
 assert.equal(await readFile(join(root,'resources/unit'),'utf8'),'unit package content');assert.equal(await readFile(join(profile,'save'),'utf8'),'persistent unit sentinel');
 await assert.rejects(installArtifact(artifact,join(out,'..','unowned'),out),/run-owned/);
});
