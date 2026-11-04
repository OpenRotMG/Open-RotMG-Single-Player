import {createReadStream} from 'node:fs';
import {chmod, mkdir, open} from 'node:fs/promises';
import {join} from 'node:path';
import {Transform, Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGunzip} from 'node:zlib';
import {Parser, Unpack, ReadEntry} from 'tar';
import {demand, MAX_EXPANDED, MAX_FILES, runtimePath, Target} from './update-format';

export async function extractRuntime(archive: string, destination: string, target: Target, expandedBytes: number): Promise<void> {
  demand(Number.isSafeInteger(expandedBytes) && expandedBytes > 0 && expandedBytes <= MAX_EXPANDED,'Invalid expanded runtime bound');
  const handle = await open(archive,'r'), first = Buffer.alloc(2);
  try { await handle.read(first,0,2,0); } finally { await handle.close(); }
  demand(first.equals(Buffer.from([31,139])), 'Runtime payload must be gzip tar');
  const paths = new Set<string>(), aliases = new Map<string,string>();let total=0;
  const inspect=(entry: ReadEntry)=>{
    const raw=entry.header.path;runtimePath(raw,target);
    demand(entry.path === raw && !entry.extended && !entry.globalExtended && entry.type === 'File' && !entry.linkpath,'Only raw regular runtime files are allowed');
    demand(!paths.has(raw) && paths.size < MAX_FILES,'Duplicate runtime archive entry or entry limit exceeded');
    for(let end=raw.indexOf('/');end!==-1;end=raw.indexOf('/',end+1)){
      const prefix=raw.slice(0,end),alias=prefix.toLowerCase();demand(!paths.has(prefix)&&(!aliases.has(alias)||aliases.get(alias)===prefix),'Archive directory case alias or file/directory collision');aliases.set(alias,prefix);
    }
    const alias=raw.toLowerCase();demand(!aliases.has(alias),'Archive case alias or file/directory collision');aliases.set(alias,raw);paths.add(raw);
    demand(Number.isSafeInteger(entry.size)&&entry.size>=0&&entry.size<=MAX_EXPANDED&&((entry.mode??0)&0o7000)===0,'Invalid archive size or privileged file mode');
    total+=entry.size;demand(total<=expandedBytes,'Runtime expanded byte limit exceeded');
  };
  const parse=new Parser({strict:true,filter:(_path,entry)=>{try{demand(entry instanceof ReadEntry,'Unexpected archive entry');inspect(entry);return true;}catch(error){parse.abort(error as Error);return false;}}});
  parse.on('entry',entry=>entry.resume());parse.on('meta',()=>parse.abort(Error('Extended tar headers are forbidden')));parse.on('ignoredEntry',()=>parse.abort(Error('Unsupported tar entry is forbidden')));
  const run=async(destinationStream: Parser)=>{
    let bytes=0;
    const limit=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;if(bytes>expandedBytes+(MAX_FILES+2)*1024)callback(Error('Decompressed archive byte limit exceeded'));else callback(null,chunk);}});
    // node-tar implements the writable stream protocol without extending node:stream.Writable.
    await pipeline(createReadStream(archive),createGunzip(),limit,destinationStream as unknown as Writable);
  };
  await run(parse);demand(total===expandedBytes&&paths.size>0,'Runtime expanded size mismatch or empty archive');
  await mkdir(destination,{recursive:false,mode:0o700});
  const unpack=new Unpack({cwd:destination,strict:true,chmod:false,preservePaths:false,filter:(_path,entry)=>{
    try{demand(entry instanceof ReadEntry,'Unexpected archive entry');runtimePath(entry.header.path,target);demand(entry.type==='File'&&entry.path===entry.header.path&&paths.has(entry.path),'Archive changed after inspection');return true;}
    catch(error){unpack.abort(error as Error);return false;}
  }});
  unpack.on('meta',()=>unpack.abort(Error('Extended tar headers are forbidden')));unpack.on('ignoredEntry',()=>unpack.abort(Error('Unsupported tar entry is forbidden')));
  await run(unpack);
  for(const path of paths)await chmod(join(destination,path),path===(target==='win32-x64'?'openrotmg.exe':'openrotmg')?0o700:0o600);
}
