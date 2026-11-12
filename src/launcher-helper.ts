import {join,resolve} from 'node:path';
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {createLauncherPolicy} from './update-policy';
import {applyLauncher} from './launcher-store';
import {demand} from './update-format';
async function main(){
 const[root,operation]=process.argv.slice(2);demand(process.argv.length===4&&typeof root==='string'&&/^[a-f0-9-]{36}$/.test(operation),'Invalid launcher helper arguments');demand(root===await realpath(root),'Launcher helper root is not canonical');const native=process.env.OPENROTMG_BOOTSTRAP;
 demand(native===join(root,'server data/handoff',operation,process.platform==='win32'?'OpenRotMG Singleplayer.exe':'OpenRotMG Singleplayer'),'Launcher helper is not bound to its native handoff');
 const pkg=JSON.parse(await readFile(join(__dirname,'../package.json'),'utf8'));await applyLauncher(root,operation,createLauncherPolicy(resolve(__dirname,'../..'),pkg.version),native!);
}
main().catch(async error=>{console.error('Launcher update failed:',error);const[root,operation]=process.argv.slice(2);if(root&&/^[a-f0-9-]{36}$/.test(operation))try{await writeFile(join(root,'server data/handoff',operation,'error.json'),JSON.stringify({error:String(error),stack:error?.stack})+'\n',{mode:0o600});}catch(recordError){console.error('Could not record launcher update failure:',recordError);}process.exitCode=1;});
