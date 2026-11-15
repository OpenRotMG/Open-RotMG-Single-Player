import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,copyFile,readdir} from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {create} from 'tar';
import {hashFile,targetName} from '../dist/update-format.js';
import {serverAssetURL} from '../dist/server-updates.js';

const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim(),json=async path=>JSON.parse(await readFile(path,'utf8'));
const head=git('rev-parse','HEAD'),target=targetName(),version=(await json('package.json')).version,pins=await json('source-pins.json');
assert.equal(git('status','--porcelain','--untracked-files=no'),'','Release source must be clean');
const output=resolve('.qa/installer-delivery');await mkdir(output);
const zips=(await readdir('out/make')).filter(name=>name.endsWith('.zip'));assert.equal(zips.length,1,'Exactly one portable ZIP required');
const name=`openrotmg-singleplayer-${version}-${target}.zip`;await copyFile(join('out/make',zips[0]),join(output,name));
execFileSync('git',['archive','--format=tar.gz',`--output=${join(output,'launcher-source.tar.gz')}`,head]);
for(const suffix of ['json','tar.gz'])await copyFile(`out/make/launcher-${target}.${suffix}`,join(output,`launcher-${target}.${suffix}`));
const serverName=`server-${target}.tar.gz`,serverArchive=join(output,serverName);
await create({file:serverArchive,cwd:'runtime',gzip:true,portable:true,noPax:true,mtime:new Date(0)},await readdir('runtime'));
await writeFile(join(output,`server-${target}.json`),JSON.stringify({format:1,kind:'openrotmg-server',version,target,minLauncher:pins.serverMinLauncher,payload:{name:serverName,url:serverAssetURL(version,serverName),bytes:(await readFile(serverArchive)).length,sha256:await hashFile(serverArchive)}})+'\n',{flag:'wx'});
const sources=[];
for(const kind of ['server','client']){
 const pin=pins[kind],repository=pin.repository.replace('https://github.com/',''),file=`${kind}-source-${pin.commit}.tar.gz`,fd=openSync(join(output,file),'wx');
 try{execFileSync('gh',['api',`repos/${repository}/tarball/${pin.commit}`],{stdio:['ignore',fd,'inherit']});}finally{closeSync(fd);}
 sources.push({kind,repository,commit:pin.commit,archive:file,sha256:await hashFile(join(output,file))});
}
for(const file of ['LICENSE','NOTICES.md','source-pins.json'])await copyFile(file,join(output,file));
const receipt={format:1,installerSourceHead:head,target,version,pins,installer:{name,sha256:await hashFile(join(output,name)),osSignature:'UNSIGNED; no Authenticode signing or Apple notarization performed'},sources};
await writeFile(join(output,'installer-receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
const checksums=[];for(const file of (await readdir(output)).sort())checksums.push(`${await hashFile(join(output,file))}  ${file}`);await writeFile(join(output,'SHA256SUMS'),checksums.join('\n')+'\n',{flag:'wx'});
console.log(join(output,name));
