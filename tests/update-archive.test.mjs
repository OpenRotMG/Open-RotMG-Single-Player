import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {writeFile,readFile,stat} from 'node:fs/promises';
import {extractRuntime} from '../dist/update-archive.js';
import {directory,rawArchive} from './update-fixture.mjs';

async function extract(entries,size=entries.reduce((n,e)=>n+Buffer.byteLength(e.body??'x'),0)){
 const root=await directory('update-archive'),archive=join(root,'payload.tar.gz'),destination=join(root,'runtime');await writeFile(archive,rawArchive(entries));
 return{root,destination,promise:extractRuntime(archive,destination,'linux-x64',size)};
}
test('update-archive extracts only inspected raw regular files through the pinned library',async()=>{
 const f=await extract([{path:'client/vendor/file.js',body:'hello'}]);await f.promise;assert.equal(await readFile(join(f.destination,'client/vendor/file.js'),'utf8'),'hello');
 if(process.platform!=='win32')assert.equal((await stat(join(f.destination,'client/vendor/file.js'))).mode&0o777,0o600);
});
test('update-archive refuses raw traversal, drive/UNC/ADS/reserved names and normalization tricks before writing',async()=>{
 for(const path of ['../../escape','/absolute','./client/file','client/../escape','client//file','C:/escape','client/file:stream','client/con.txt','client/trailing.','client/back\\slash','\\\\host\\share','client/%2e%2e/file']){
  const f=await extract([{path:'client/safe',rawPath:path}]);await assert.rejects(f.promise,undefined,path);await assert.rejects(stat(f.destination),{code:'ENOENT'});
 }
});
test('update-archive rejects links, directories, metadata, unknown types, privileged modes and duplicates',async()=>{
 for(const entry of [{path:'client/link',type:'SymbolicLink',linkpath:'../../escape'},{path:'client/link',type:'Link',linkpath:'client/file'},{path:'client/dir',type:'Directory',body:''},{path:'client/meta',type:'ExtendedHeader',body:'10 path=x\n'},{path:'client/device',type:'CharacterDevice'},{path:'client/fifo',type:'FIFO'},{path:'client/root',mode:0o4755}]){
  const f=await extract([entry]);await assert.rejects(f.promise,undefined,entry.type??'privileged');await assert.rejects(stat(f.destination),{code:'ENOENT'});
 }
 for(const paths of [['client/a','client/a'],['client/A','client/a'],['client/Dir/a','client/dir/b'],['client/a','client/a/b'],['client/a/b','client/a']]){
  const f=await extract(paths.map(path=>({path})));await assert.rejects(f.promise,/Duplicate|alias|collision/);await assert.rejects(stat(f.destination),{code:'ENOENT'});
 }
});
test('update-archive refuses mismatched expanded bounds and truncated gzip',async()=>{
 const small=await extract([{path:'client/file',body:'hello'}],4);await assert.rejects(small.promise,/limit exceeded/);
 const large=await extract([{path:'client/file',body:'hello'}],6);await assert.rejects(large.promise,/size mismatch/);
 const root=await directory('update-truncated'),archive=join(root,'payload.tar.gz'),bytes=rawArchive([{path:'client/file',body:'hello'}]);await writeFile(archive,bytes.subarray(0,bytes.length-10));await assert.rejects(extractRuntime(archive,join(root,'runtime'),'linux-x64',5));
});
