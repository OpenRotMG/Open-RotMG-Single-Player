import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {RuntimeStore as ProductionStore,durableBytes as posixBytes} from '../dist/update-store.js';
import {RuntimeUpdates as ProductionUpdates} from '../dist/updates.js';

// Existing state-machine fixtures contain fake ELF bytes, not a runnable bundled Windows helper.
// Their Windows namespace effects are simulated; native tests use the production publisher separately.
export async function durableBytes(path,bytes,distinct=false){
 if(process.platform!=='win32')return posixBytes(path,bytes,distinct);
 const temporary=path+'.partial-'+randomUUID(),file=await fs.open(temporary,'wx',0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
 if(distinct){await fs.link(temporary,path);await fs.unlink(temporary);}else await fs.rename(temporary,path);
 const published=await fs.open(path,'r+');try{await published.sync();}finally{await published.close();}
}
export const durableRecord=(path,value,distinct=false)=>durableBytes(path,Buffer.from(JSON.stringify(value,null,2)+'\n'),distinct);
function simulation(root){return{prepare:()=>fs.mkdir(root,{recursive:true}),rootExists:()=>fs.mkdir(root,{recursive:true}),container:path=>fs.mkdir(path,{recursive:true}),bytes:durableBytes,move:(source,destination)=>fs.rename(source,destination)};}
export class RuntimeStore extends ProductionStore{constructor(...args){super(...args);if(process.platform==='win32')this.metadata=simulation(this.userData);}}
export class RuntimeUpdates extends ProductionUpdates{constructor(...args){super(...args);if(process.platform==='win32')this.store.metadata=simulation(this.store.userData);}}
