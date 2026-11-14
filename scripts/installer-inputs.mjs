import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,copyFile,readdir} from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {hashFile,targetName} from '../dist/update-format.js';

// Collects the release assets for one target: the ZIP, its signed-update payload and corresponding source.
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim(),json=async path=>JSON.parse(await readFile(path,'utf8'));
const head=git('rev-parse','HEAD'),target=targetName(),version=(await json('package.json')).version,pins=await json('source-pins.json');
assert.equal(git('status','--porcelain','--untracked-files=no'),'','Release source must be clean');
const output=resolve('.qa/installer-delivery');await mkdir(output);
const zips=(await readdir('out/make')).filter(name=>name.endsWith('.zip'));assert.equal(zips.length,1,'Exactly one portable ZIP required');
const name=`openrotmg-singleplayer-${version}-${target}.zip`;await copyFile(join('out/make',zips[0]),join(output,name));
execFileSync('git',['archive','--format=tar.gz',`--output=${join(output,'launcher-source.tar.gz')}`,head]);
for(const suffix of ['json','tar.gz'])await copyFile(`out/make/launcher-${target}.${suffix}`,join(output,`launcher-${target}.${suffix}`));
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
