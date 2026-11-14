import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
export const tick=()=>new Promise(resolve=>setImmediate(resolve));
export const metadata={account:1,login:'player-1@local.invalid',replaced:true,disclosure:'Personal progress only.',exported_at:1700000000,name:'Guest1',character_count:2,expected:'a'.repeat(64)};
export async function rendererFixture(){
 const elements=new Map(),calls=[];let changed,launcherUpdated;
 const node=(tag='')=>({tagName:tag.toLowerCase(),querySelectorAll(selector){const names=selector.split(',');return this.children.flatMap(child=>[...(names.includes(child.tagName)?[child]:[]),...child.querySelectorAll(selector)]);},textContent:'',value:'',disabled:false,hidden:false,checked:false,open:false,children:[],attributes:{},setAttribute(name,value){this.attributes[name]=value;},removeAttribute(name){delete this.attributes[name];},getAttribute(name){return this.attributes[name];},addEventListener(name,fn){this['on'+name]=fn;},focus(){this.focused=true;},showModal(){this.open=true;},close(){this.open=false;},append(...children){this.children.push(...children);},replaceChildren(){this.children=[];}});
 const html=await readFile('src/index.html','utf8');for(const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)){const value=node();value.hidden=/\bhidden\b/.test(match[0]);value.checked=/\bchecked\b/.test(match[0]);elements.set(match[1],value);}
 const element=id=>{if(!elements.has(id))throw Error('Missing actual HTML control: '+id);return elements.get(id);};
 const runtime={botsEnabled:false,status:'stopped',logs:[],message:'Stopped',diagnostics:'private/diagnostics',closing:false};
 const launcher={copyLogs:async text=>calls.push(['copy',text]),status:async()=>runtime,setBots:async enabled=>{runtime.botsEnabled=enabled;calls.push(['bots',enabled]);},launcherUpdates:async()=>({installed:'0.1.3',phase:'idle',message:''}),changed:fn=>changed=fn,launcherChanged:fn=>launcherUpdated=fn,launcherHealthy:async()=>{},recoverLauncher:async()=>({installed:'0.1.4',phase:'idle',message:'Checked'}),listBackups:async()=>[],saveLocation:async()=>'/owned/player data',start:async()=>calls.push(['start']),startInstalled:async()=>calls.push(['installed']),client:async()=>calls.push(['client']),stop:async()=>calls.push(['stop']),checkUpdates:async()=>{calls.push(['check']);return update;},retryUpdate:async()=>{calls.push(['retry']);return update;},recoverRuntime:async()=>{calls.push(['recover']);return update;},releases:async()=>calls.push(['releases']),listAccounts:async()=>[],importPlayer:async()=>metadata,cancelImport:async()=>true};
 const source=ts.transpileModule(await readFile('src/renderer.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 runInNewContext(source,{exports:{},URL,setInterval:()=>0,navigator:{},document:{getElementById:element,createElement:node},window:{launcher}});await tick();
 return{element,elements,html,calls,launcher,runtime,launcherChange:value=>launcherUpdated(value),change:value=>{Object.assign(runtime,value);changed({...runtime});}};
}
