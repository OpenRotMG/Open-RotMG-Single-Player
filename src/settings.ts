import {lstat,mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export class LocalSettings {
  private readonly path:string;
  bots=false;
  constructor(private storage:string){this.path=join(storage,'launcher-settings.json');}
  async load(){
    let info;
    try{info=await lstat(this.path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){this.bots=false;return;}throw error;}
    if(!info?.isFile()||info.isSymbolicLink()||info.size>1024)throw Error('Local settings must be a small regular file');
    const value=JSON.parse(await readFile(this.path,'utf8'));
    if(Object.keys(value).sort().join(',')!=='bots,format'||value.format!==1||typeof value.bots!=='boolean')throw Error('Invalid local launcher settings');
    this.bots=value.bots;
  }
  async setBots(enabled:boolean){
    if(typeof enabled!=='boolean')throw Error('Bots setting must be boolean');
    await this.load();await mkdir(this.storage,{recursive:true,mode:0o700});
    const temporary=join(this.storage,'launcher-settings-'+randomUUID()+'.tmp');
    await writeFile(temporary,JSON.stringify({format:1,bots:enabled})+'\n',{flag:'wx',mode:0o600,flush:true});
    await rename(temporary,this.path);this.bots=enabled;
  }
}
