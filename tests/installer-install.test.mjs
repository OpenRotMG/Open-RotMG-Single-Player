import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,stat,chmod} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {portableZip} from '../scripts/make-zip.mjs';
import {installArtifact,installedPaths} from '../scripts/installer-install.mjs';
import {protectInstallation,assertInstallationProtected} from '../scripts/native-boundaries.mjs';

test('portable ZIP extracts to exactly the launcher, README.txt, empty player data and protected server data (unit content, not a production app)',{skip:process.platform!=='linux'},async()=>{
 await mkdir('.qa/unit',{recursive:true});const out=await mkdtemp(resolve('.qa/unit/portable-')),input=join(out,'package'),launcher=join(out,'launcher');
 await mkdir(join(input,'resources'),{recursive:true});await writeFile(join(input,'resources/unit'),'unit package content');
 await writeFile(launcher,'#!/bin/sh\n');await chmod(launcher,0o755);
 const zip=join(out,'portable.zip');await portableZip({packageDir:input,launcher,readme:resolve('launcher/README.txt'),stage:join(out,'stage'),zip});
 const root=join(out,'extracted é 日本');await installArtifact(zip,root,out);const paths=installedPaths(root);
 assert.equal(await readFile(join(paths.server,'resources/unit'),'utf8'),'unit package content');assert.equal((await stat(paths.launcher)).mode&0o111,0o111);
 assert.match(await readFile(join(root,'README.txt'),'utf8'),/player data/);
 await protectInstallation(paths.server);if(process.getuid()!==0)await assertInstallationProtected(paths.server,paths.resources);
 await writeFile(join(paths.player,'save'),'player data stays writable');
 await assert.rejects(installArtifact(zip,root,out),/EEXIST/);await assert.rejects(installArtifact(zip,join(out,'..','unowned'),out),/run-owned/);
 assert.deepEqual([...new Set(execFileSync('unzip',['-Z1',zip],{encoding:'utf8'}).trim().split('\n').map(line=>line.split('/')[0]))].sort(),['OpenRotMG Singleplayer','README.txt','player data','server data']);
});
