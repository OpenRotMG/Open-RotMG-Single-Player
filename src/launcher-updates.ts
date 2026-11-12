import {EventEmitter} from 'node:events';
import {LauncherStore} from './launcher-store';
import {UserMessage} from './user-message';
import type {View} from './runtime';
import type {UpdateView} from './updates';
export function requireLauncherSaveState(runtime:Pick<View,'status'|'pid'|'operation'>,game:Pick<UpdateView,'phase'|'canManageSaves'|'needsStart'>,stopped=false){if(!['stopped','ready'].includes(runtime.status)||runtime.operation||game.phase==='recovery'||!(game.canManageSaves||game.needsStart)||runtime.status==='stopped'&&runtime.pid||stopped&&(runtime.status!=='stopped'||runtime.pid))throw new UserMessage('The save is not ready for a launcher update. Finish any running operation or use Check save. If the game has already stopped, close and reopen the launcher first.');}
import {REPOSITORY,Target,decodeJson,demand,integer,launcherVersion,versionAtLeast} from './update-format';

export type LauncherUpdateView={installed:string;available?:string;phase:'idle'|'checking'|'current'|'available'|'error'|'downloading'|'installing'|'recovery';message:string;blocked?:boolean};
const discovery=`https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`;
export class LauncherUpdates extends EventEmitter {
  private state:LauncherUpdateView;private task?:Promise<LauncherUpdateView>;private controller?:AbortController;private downloadURL?:string;
  constructor(private installed:string,private target:Target,private request:typeof fetch=fetch,private store?:LauncherStore){super();launcherVersion(installed);this.state={installed,phase:'idle',message:''};}
  view(){return {...this.state};}
  private changed(){this.emit('change',this.view());}
  abort(){this.controller?.abort();}
  get busy(){return ['downloading','installing'].includes(this.state.phase);}
  async startup(){if(this.store){await this.store.verifySelected();this.state.blocked=await this.store.blocked();if(this.state.blocked){this.state.phase='recovery';this.state.message='A launcher update did not finish. Check launcher files before playing.';}}return this.view();}
  async prepare(){
    demand(this.store&&this.state.phase==='available'&&this.state.available&&!this.state.blocked,'Check for an authenticated launcher update first');const version=this.state.available,controller=new AbortController();this.controller=controller;this.state={...this.state,phase:'downloading',message:'Downloading launcher…'};this.changed();
    try{const prepared=await this.store.stage(version,controller.signal,message=>{this.state.message=message;this.changed();});this.state.phase='installing';this.state.message='Saving and reopening…';this.changed();return prepared;}
    catch(error){this.state.phase='error';this.state.message=`Launcher update failed: ${String(error)}`;this.changed();throw error;}finally{this.controller=undefined;}
  }
  async arm(prepared:{id:string;version:string}){demand(this.store&&this.state.phase==='installing','Launcher preparation is incomplete');return this.store.arm(prepared.id,prepared.version);}
  async healthy(operation:string){demand(this.store,'Missing portable launcher authority');await this.store.healthy(operation);this.state={installed:this.installed,phase:'current',message:`Launcher ${this.installed} updated.`,blocked:false};this.changed();}
  async prune(){demand(this.store,'Missing portable launcher authority');await this.store.prune();}
  async recover(){demand(this.store&&!this.busy,'Launcher files cannot be checked during an update');await this.store.recover();this.state={installed:this.installed,phase:'idle',message:'Launcher files checked. The interrupted update was not replayed.',blocked:false};this.changed();return this.view();}
  failed(error:unknown){this.state.phase=this.state.blocked?'recovery':'error';this.state.message=`Launcher update failed: ${String(error)}`;this.changed();}
  download(){demand(this.state.phase==='available'&&this.downloadURL,'Check for a newer launcher before downloading');return this.downloadURL;}
  check():Promise<LauncherUpdateView>{
    if(this.task)return this.task;
    demand(!this.busy&&!this.state.blocked,'Finish or check the existing launcher update first');
    this.downloadURL=undefined;this.state={installed:this.installed,phase:'checking',message:'Checking launcher releases…'};
    const controller=new AbortController();this.controller=controller;
    const task=this.discover(AbortSignal.any([controller.signal,AbortSignal.timeout(20_000)])).catch(error=>{
      this.state={installed:this.installed,phase:'error',message:`Launcher update check failed: ${error instanceof Error?error.message:String(error)}`};return this.view();
    }).finally(()=>{this.task=undefined;this.controller=undefined;this.changed();});this.task=task;return task;
  }
  private async discover(signal:AbortSignal):Promise<LauncherUpdateView>{
    const response=await this.request(discovery,{redirect:'error',signal,headers:{accept:'application/vnd.github+json'}});
    if(!response.ok){await response.body?.cancel();throw Error(`GitHub launcher releases returned HTTP ${response.status}`);}
    if(response.headers.get('link')?.includes('rel="next"')){await response.body?.cancel();throw Error('Launcher history exceeds the checked 100-release bound');}
    demand(response.body,'Launcher release response has no body');const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0,complete=false;
    try{for(;;){const chunk=await reader.read();if(chunk.done){complete=true;break;}size+=chunk.value.byteLength;demand(size<=2*1024*1024,'Launcher release response exceeds 2 MiB');parts.push(chunk.value);}}
    finally{if(!complete)await reader.cancel();reader.releaseLock();}
    const releases=decodeJson(Buffer.concat(parts),2*1024*1024);demand(Array.isArray(releases)&&releases.length<=100,'Invalid launcher release list');
    let latest:{version:string;url:string}|undefined;
    for(const release of releases){
      demand(release&&typeof release==='object','Invalid launcher release record');
      demand(typeof release.draft==='boolean'&&typeof release.prerelease==='boolean','Invalid launcher release visibility');
      if(release.draft||release.prerelease)continue;
      const marker=typeof release.body==='string'?/^LAUNCHER_VERSION=(.+)$/m.exec(release.body):null;
      if(!marker&&release.tag_name!=='v0.1.0'){
        demand(!release.assets?.some((a:{name?:string})=>a.name?.startsWith('openrotmg-singleplayer-')),'A launcher package was published without its version marker');continue;
      }
      const version=marker?marker[1].replace(/\r$/,''):'0.1.0';launcherVersion(version);
      demand(release.tag_name===`v${version}`&&integer(release.id,1)&&release.url===`https://api.github.com/repos/${REPOSITORY}/releases/${release.id}`,'Launcher version/tag/repository mismatch');
      demand(Array.isArray(release.assets),'Launcher release assets are missing');
      const name=`openrotmg-singleplayer-${version}-${this.target}.zip`,assets=release.assets.filter((a:{name:string})=>a.name===name);
      demand(assets.length===1&&integer(assets[0].size,1)&&assets[0].browser_download_url===`https://github.com/${REPOSITORY}/releases/download/v${version}/${name}`,'Launcher ZIP is missing or outside the official release');
      if(!latest||versionAtLeast(version,latest.version))latest={version,url:assets[0].browser_download_url};
    }
    demand(latest,'No published launcher release was found');
    const newer=latest.version!==this.installed&&versionAtLeast(latest.version,this.installed);
    this.downloadURL=newer?latest.url:undefined;
    this.state={installed:this.installed,available:latest.version,phase:newer?'available':'current',message:newer?`Launcher ${latest.version} is available.`:'No newer published launcher.'};return this.view();
  }
}
