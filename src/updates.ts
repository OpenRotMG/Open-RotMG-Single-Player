import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {copyFile,lstat,mkdir,rename,stat,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {constants} from 'node:fs';
import type {AuthorityCompletion,Runtime} from './runtime';
import {AuthorityUnchangedError,saveAuthority,SaveAuthorityRuntime,snapshotPreview} from './saves';
import {boundedFile,demand,digest,exact,hashFile,integer,UpdateProblem,verifyRuntime} from './update-format';
import {extractRuntime} from './update-archive';
import {discover,downloadPayload} from './update-network';
import {UpdatePolicy} from './update-policy';
import {durableBytes,durableRecord,exists,generation,Generation,record,RuntimeStore,select,Selection,selection,syncDirectory} from './update-store';
import {Backup,backup,backupName,backupPath,NativeStartupAck,Pending,pending,readNativeAck,readPending} from './update-journal';
import {Activity,Authorization,ReadyProof,Receipt,RecoveredRuntimeFence} from './update-recovery';

export type RuntimeSummary={version:string;sequence:number;server:string;client:string;ruffle:string;kind:'source'|'release'};
export type UpdateView={phase:'initializing'|'checking'|'downloading'|'staged'|'activating'|'ready'|'unavailable'|'service'|'rejected'|'launcher'|'recovery'|'canceled';message:string;installed?:RuntimeSummary;available?:RuntimeSummary;canPlayInstalled:boolean;canRecover:boolean;canRetry:boolean};
export type UpdateConfirmation={kind:'restore-update'|'verify-current'|'retry-update';message:string;detail:string};
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const summary=(g:Generation):RuntimeSummary=>({version:g.version,sequence:g.sequence,server:g.pins.server.commit,client:g.pins.client.commit,ruffle:g.pins.ruffle.version,kind:g.kind});
const fileName=(reason:string,id=randomUUID())=>`${new Date().toISOString().replaceAll(':','-')}-${reason}-${id}.sqlite`;
export class RuntimeUpdates extends EventEmitter{
  readonly store:RuntimeStore;readonly fence:RecoveredRuntimeFence;
  private initialization?:Promise<void>;private task?:Promise<UpdateView>;private controller?:AbortController;
  private current?:Generation;private committed?:Generation;private staged?:Generation;private available?:RuntimeSummary;
  private transaction?:Pending;private startingPending?:Pending;private startAuthorization?:Authorization;
  private authorityActivity?:Activity;private serverActivity?:Activity;private explicitRecovery=false;private bookkeepingTask?:Promise<void>;private quarantined=false;private recoveryCompletion?:{command:string;ack:unknown};private recoveryAuthority?:AuthorityCompletion;
  private refusedCheck?:{format:1;kind:'service'|'rejected'|'launcher';message:string;selected:Selection};
  private failureSerial=0;private failure?:UpdateProblem;private phase:UpdateView['phase']='initializing';private message='Preparing explicit installed runtime…';
  constructor(private runtime:Runtime,readonly policy:UpdatePolicy,private confirm:(value:UpdateConfirmation)=>Promise<boolean>){
    super();this.store=new RuntimeStore(runtime.userData,policy);this.fence=new RecoveredRuntimeFence(this.store);runtime.attachUpdates(this);
    runtime.on('change',()=>{
      if(runtime.view().status==='failed'&&this.phase!=='recovery')this.problem(new UpdateProblem('recovery',runtime.view().message));
      if(this.staged&&!this.quarantined&&!this.task&&runtime.isIdle())void this.applyDeferred();
      this.emit('change',this.view());
    });
  }
  view():UpdateView{
    return{phase:this.phase,message:this.message,installed:this.committed?summary(this.committed):undefined,available:this.available,canPlayInstalled:!!this.current&&this.runtime.isIdle()&&!this.transaction&&!!this.failure&&this.failure.kind!=='recovery',canRecover:this.phase==='recovery',canRetry:!!this.staged&&!this.transaction&&this.phase==='rejected'};
  }
  private update(phase:UpdateView['phase'],message:string){this.phase=phase;this.message=message;this.emit('change',this.view());}
  private problem(error:unknown){
    const recovery=!!this.transaction||this.runtime.view().status==='failed'||this.phase==='initializing'||this.phase==='recovery';
    const value=error instanceof UpdateProblem&&!recovery?error:new UpdateProblem(recovery?'recovery':'rejected',error instanceof Error?error.message:String(error));this.failure=value;if(this.staged)this.quarantined=true;this.update(value.kind,value.message);
  }
  startup():Promise<UpdateView>{
    demand(!this.initialization,'Runtime updates already initialized');
    this.initialization=this.runtime.idleOperation('Prepare installed runtime',()=>this.initializeOwned());
    this.initialization.catch(error=>this.problem(error));return this.check();
  }
  private async initializeOwned(){
    const value=await this.store.initialize();this.current=value.selected;this.committed=value.selected;
    if(await exists(this.store.path('runtime-check-refusal.json'))){const refused=await record(this.store.path('runtime-check-refusal.json'));exact(refused,'format,kind,message,selected','unresolved runtime check refusal');demand(refused.format===1&&['service','rejected','launcher'].includes(String(refused.kind))&&typeof refused.message==='string'&&refused.message.length<=4000,'Invalid persisted runtime check refusal');await this.store.load(selection(refused.selected));this.refusedCheck=refused as typeof this.refusedCheck;}
    if(await exists(this.store.path('runtime-pending.json'))){
      this.transaction=await readPending(this.store);await this.store.load(this.transaction.from);await this.store.load(this.transaction.to);
      this.committed=await this.store.load(this.transaction.from);
      demand(equal(select(value.selected),this.transaction.to)||this.transaction.phase==='preparing'&&equal(select(value.selected),this.transaction.from),'Pending journal and authoritative selection disagree; explicit recovery required');
    }
    this.runtime.selectResources(this.store.root(value.selected.id));
    if(this.transaction&&this.transaction.phase!=='selected')throw new UpdateProblem('recovery','Interrupted startup/update is pending. No automatic migration replay, prior-runtime fallback or restore is permitted; use explicit recovery.');
    if(!this.transaction)await this.fence.requireClean(select(value.selected));
    this.update('ready',`Installed ${value.selected.version}; an update check has not yet completed.`);
  }
  private async recordRefusal(error?:UpdateProblem){
    const path=this.store.path('runtime-check-refusal.json');
    if(error){demand(this.current&&['service','rejected','launcher'].includes(error.kind),'Invalid runtime refusal context');const value={format:1 as const,kind:error.kind as 'service'|'rejected'|'launcher',message:error.message.slice(0,4000),selected:select(this.current)};await durableRecord(path,value);this.refusedCheck=value;}
    else{if(await exists(path)){await unlink(path);await syncDirectory(this.runtime.userData);}this.refusedCheck=undefined;}
  }
  private async initialized(){if(this.initialization)await this.initialization;else await this.initializeOwned();}
  check():Promise<UpdateView>{
    if(this.task)return this.task;
    const controller=new AbortController();this.controller=controller;
    const task=(async()=>{
      let stage:string|undefined,primary:unknown;
      try{
        await this.initialized();
        if(this.transaction){
          if(this.transaction.phase==='selected'){this.update('staged','Authenticated runtime selected; next Start must complete guarded startup before update success.');return this.view();}
          throw new UpdateProblem('recovery','A previous runtime operation requires explicit recovery; no new update was attempted');
        }
        this.failure=undefined;this.update('checking','Checking the trusted release generation…');
        const discovered=await discover(this.policy,controller.signal,(bytes,signature,sequence)=>this.store.remember(bytes,signature,{sequence})),m=discovered.manifest;
        this.available={version:m.version,sequence:m.sequence,server:m.pins.server.commit,client:m.pins.client.commit,ruffle:m.pins.ruffle.version,kind:'release'};
        demand(this.current,'Installed runtime was not initialized');const profile=await this.store.profile();
        const floor=Math.max(this.current.sequence,await this.store.authenticatedFloor(),...profile.attempts.map(a=>a.sequence));
        demand(m.sequence>=floor,'Authenticated release is older than installed/attempted runtime history; refusing rollback');
        const id=`release-${m.sequence}-${digest(discovered.bytes)}`;
        if(m.sequence===this.current.sequence){demand(id===this.current.id,'Same positive runtime sequence has a different installed identity');this.staged=undefined;await this.recordRefusal();this.update('ready',`Installed ${this.current.version} matches the checked authenticated release.`);return this.view();}
        if(await exists(join(this.store.generations,id)))this.staged=await this.loadId(id);
        else{
          this.update('downloading',`Downloading and verifying paired runtime ${m.version}…`);stage=await this.store.stage();
          await durableBytes(join(stage,'manifest.json'),discovered.bytes);await durableBytes(join(stage,'manifest.sig'),discovered.signature);
          const archive=join(stage,'payload.tar.gz');await downloadPayload(m,archive,this.policy,controller.signal);
          await extractRuntime(archive,join(stage,'runtime'),this.policy.target,m.payload.expandedBytes);
          const identity=await verifyRuntime(join(stage,'runtime'),this.policy.target,m),g=generation(identity,digest(await boundedFile(join(stage,'runtime','build-identity.json'))),this.policy.target,1,1,m,digest(discovered.bytes));
          await unlink(archive);await this.store.publish(stage,g);stage=undefined;this.staged=g;
        }
        this.quarantined=profile.failed.includes(this.staged.id);
        if(this.quarantined)throw new UpdateProblem('rejected','This authenticated runtime previously failed and is quarantined. Play the verified installed version, explicitly retry this exact candidate, or wait for a newer eligible release.');
        await this.recordRefusal();this.update('staged',`Verified ${m.version}; activation is deferred while a game or lifecycle operation is active.`);
        if(this.runtime.isIdle())await this.runtime.idleOperation('Activate paired runtime update',()=>this.activateOwned(this.staged!));
      }catch(error){
        primary=error;this.problem(error);
        if(this.current&&!this.transaction&&this.failure&&['service','rejected','launcher'].includes(this.failure.kind)){
          try{await this.recordRefusal(this.failure);}catch(persistence){this.runtime.blockAmbiguousSave(new Error(`Runtime check refused: ${String(error)}; could not persist refusal: ${String(persistence)}`));await this.runtime.verifyFailureGate();this.problem(new UpdateProblem('recovery','Runtime rejection persistence failed; ownership retained and old code must not be launched automatically'));}
        }else if(this.failure?.kind==='unavailable'&&this.refusedCheck)this.update('unavailable',`${this.failure.message}. Earlier ${this.refusedCheck.kind} remains unresolved: ${this.refusedCheck.message}. Explicit Play installed version is required.`);
      }
      finally{
        controller.abort();if(stage){try{await this.store.cleanup(stage,primary);}catch(error){this.problem(error);}}
      }
      return this.view();
    })().finally(()=>{if(this.task===task)this.task=undefined;if(this.controller===controller)this.controller=undefined;});
    this.task=task;return task;
  }
  private applyDeferred():Promise<UpdateView>{
    if(this.task)return this.task;
    const task=this.runtime.idleOperation('Activate deferred runtime update',()=>this.activateOwned(this.staged!)).then(()=>this.view(),error=>{this.problem(error);return this.view();}).finally(()=>{if(this.task===task)this.task=undefined;});this.task=task;return task;
  }
  private async loadId(id:string){const value=await record(join(this.store.generations,id,'generation.json')) as Generation;demand(value?.id===id,'Staged generation descriptor points at a different runtime');return this.store.load(select(value));}
  private authority(g:Generation):SaveAuthorityRuntime{
    return{resources:this.store.root(g.id),runtimePaths:()=>({...this.runtime.runtimePaths(),binary:join(this.store.root(g.id),this.policy.target==='win32-x64'?'openrotmg.exe':'openrotmg'),data:join(this.store.root(g.id),'data')}),blockAmbiguousSave:error=>this.runtime.blockAmbiguousSave(error),authorityStarting:(command,binary)=>this.runtime.authorityStarting(command,binary),authorityClosed:completion=>this.runtime.authorityClosed(completion)};
  }
  private async sealedBackup(path:string){
    try{demand((await stat(path+'-wal')).size===0,'Independent backup has a nonempty WAL; no checkpoint-only restore is permitted');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  private async verifiedBackup(g:Generation,name:string):Promise<Backup>{
    const path=backupPath(this.store,name);await this.sealedBackup(path);
    const metadata=snapshotPreview(await saveAuthority(this.authority(g),'verify-snapshot',[path,join(this.store.root(g.id),'data')]));await this.sealedBackup(path);
    return{name,sha256:await hashFile(path),metadata,authority:select(g)};
  }
  private async stageRecoveryInput(input:Backup):Promise<{stage:string;path:string}>{
    const stage=await this.store.stage(),source=backupPath(this.store,input.name),path=join(stage,'input.sqlite');
    try{
      const before=await lstat(source);demand(before.isFile()&&!before.isSymbolicLink(),'Recovery input is not a regular independent snapshot');await this.sealedBackup(source);
      await copyFile(source,path,constants.COPYFILE_EXCL);const after=await lstat(source);await this.sealedBackup(source);
      demand(before.size===after.size&&before.mtimeMs===after.mtimeMs&&await hashFile(path)===input.sha256&&await hashFile(source)===input.sha256,'Fresh startup backup changed while privately staged');
      return{stage,path};
    }catch(error){await this.store.cleanup(stage,error);throw error;}
  }
  private async snapshot(g:Generation,name:string):Promise<{backup:Backup;ack:unknown}>{
    const ack=await saveAuthority(this.authority(g),'snapshot',[this.runtime.runtimePaths().state,join(this.store.root(g.id),'data'),backupPath(this.store,name)]);
    if(this.explicitRecovery)this.recoveryCompletion={command:'snapshot',ack};
    try{return{backup:await this.verifiedBackup(g,name),ack};}catch(error){throw new UpdateProblem('recovery',`Snapshot actual close0/strict acknowledgement=${JSON.stringify(ack)}; follow-up verification failed: ${String(error)}`);}
  }
  private async writePending(p:Pending){pending(p);await durableRecord(this.store.path('runtime-pending.json'),p);this.transaction=p;}
  private async archivePending(p:Pending){
    const directory=join(this.runtime.userData,'runtime-recovery-history');await mkdir(directory,{recursive:true,mode:0o700});
    const data=await boundedFile(this.store.path('runtime-pending.json'));demand(equal(pending(JSON.parse(data.toString('utf8'))),p),'Pending runtime record changed before settlement');
    const path=join(directory,`${digest(data)}.pending.json`);demand(!await exists(path),'Pending settlement evidence already exists');await rename(this.store.path('runtime-pending.json'),path);await syncDirectory(directory);await syncDirectory(this.runtime.userData);this.transaction=undefined;
  }
  private async activateOwned(candidate:Generation,retry=false){
    demand(!this.runtime.view().pid&&!this.transaction,'Activation requires stopped, unambiguous lifecycle ownership');
    const from=await this.store.load(selection(await record(this.store.path('runtime-selection.json')))),to=await this.store.load(select(candidate)),profile=await this.store.profile();
    await this.fence.requireClean(select(from));demand(to.sequence>from.sequence&&to.startupBackup===1&&to.clientNamespace===1,'Candidate cannot advance this installed runtime');
    demand(retry||!profile.failed.includes(to.id),'Failed runtime requires an explicit retry');
    const id=randomUUID(),p:Pending={format:1,id,kind:'update',phase:'preparing',from:select(from),to:select(to),preBackup:null,noDatabase:!await exists(join(this.runtime.runtimePaths().state,'game.db')),migrationName:fileName('pre-start',id),pid:null,nativeAck:null,readiness:null,failureSha256:null,recovery:null};
    await mkdir(join(this.runtime.userData,'backups'),{recursive:true,mode:0o700});await this.writePending(p);
    this.update('activating','Creating an independent pre-update backup and verifying candidate code/data…');
    try {
      if(!p.noDatabase){
        p.preBackup=(await this.snapshot(from,fileName('pre-update'))).backup;
        await saveAuthority(this.authority(to),'verify-snapshot',[backupPath(this.store,p.preBackup.name),join(this.store.root(to.id),'data')]);await this.writePending(p);
      }
    } catch(error) {
      if(error instanceof AuthorityUnchangedError&&this.runtime.view().status!=='failed'){
        demand(equal(selection(await record(this.store.path('runtime-selection.json'))),p.from),'Unchanged backup refusal has a foreign current selection');
        await this.archivePending(await readPending(this.store));
      }
      throw error;
    }
    if(!profile.attempts.some(a=>a.id===to.id)){profile.attempts.push({id:to.id,sequence:to.sequence});await durableRecord(this.store.path('runtime-profile.json'),profile);}
    await this.store.choose(to);p.phase='selected';await this.writePending(p);this.current=to;this.staged=undefined;this.runtime.selectResources(this.store.root(to.id));
    this.update('staged',`Paired runtime ${to.version} selected. Start will take a fresh under-lock backup; actual readiness is still pending.`);
  }
  async beforeStart(installedOnly:boolean){
    await this.initialized();if(installedOnly&&this.task)await this.task;
    if(this.transaction){demand(!installedOnly&&this.transaction.phase==='selected'&&this.transaction.failureSha256===null,'Pending migration/recovery forbids installed-version play or automatic replay');}
    else if(!installedOnly){
      await this.check();if(this.failure&&this.failure.kind!=='unavailable')throw this.failure;
      if(this.failure?.kind==='unavailable'){
        const floor=Math.max(await this.store.authenticatedFloor(),...(await this.store.profile()).attempts.map(a=>a.sequence));
        demand(!this.refusedCheck&&floor<=this.current!.sequence,'A prior refused check or newer authenticated runtime remains unresolved while offline; use explicit Play installed version, not automatic old-code fallback');
      }
      if(this.staged&&!this.failure)await this.activateOwned(this.staged);
    }
    const selected=await this.store.load(selection(await record(this.store.path('runtime-selection.json'))));this.current=selected;
    if(this.transaction){demand(equal(this.transaction.to,select(selected))&&this.transaction.phase==='selected','Selected startup generation differs from pending update');this.startAuthorization=await this.fence.requireClean(this.transaction.from);}
    else this.startAuthorization=await this.fence.requireClean(select(selected));
    this.runtime.selectResources(this.store.root(selected.id));
    if(selected.startupBackup===0){
      demand(!this.transaction&&selected.kind==='source','Legacy runtime is not an eligible protected update');
      if(await exists(join(this.runtime.runtimePaths().state,'game.db'))){const metadata=snapshotPreview(await saveAuthority(this.authority(selected),'verify-snapshot',[join(this.runtime.runtimePaths().state,'game.db'),join(this.store.root(selected.id),'data')]));demand(metadata.schema===22,'Legacy source runtime cannot safely migrate this save; use a guarded-start capable runtime');}
      return;
    }
    if(!this.transaction){const id=randomUUID();await mkdir(join(this.runtime.userData,'backups'),{recursive:true,mode:0o700});await this.writePending({format:1,id,kind:'start',phase:'selected',from:select(selected),to:select(selected),preBackup:null,noDatabase:!await exists(join(this.runtime.runtimePaths().state,'game.db')),migrationName:fileName('pre-start',id),pid:null,nativeAck:null,readiness:null,failureSha256:null,recovery:null});}
    this.update('activating','Guarded startup prepared: fresh Rust backup and actual owned readiness are required.');
  }
  clientURL(){demand(this.current,'Client runtime has not been verified');return this.runtime.origin+(this.current.clientNamespace===1?`/_runtime/${this.current.identitySha256}/`:'/');}
  startupConfig(){
    demand(this.current,'Startup runtime has not been verified');
    return{...(this.current.clientNamespace===1?{client_generation:this.current.identitySha256}:{}),...(this.transaction&&['selected','starting'].includes(this.transaction.phase)?{pre_migration_backup:backupPath(this.store,this.transaction.migrationName)}:{})};
  }
  async beforeSpawn(binary:string){
    demand(this.current&&binary===join(this.store.root(this.current.id),this.policy.target==='win32-x64'?'openrotmg.exe':'openrotmg'),'Startup binary differs from selected pair');
    this.serverActivity=await this.fence.active('server',select(this.current),this.transaction?.id??null,this.startAuthorization);
    if(this.transaction){const p={...this.transaction,phase:'starting' as const};await this.writePending(p);this.startingPending=p;}
  }
  async spawned(pid:number){
    demand(integer(pid,1),'Spawn returned no owned native PID; no startup proof is claimed');
    if(this.transaction){const p={...this.transaction,pid};await this.writePending(p);this.startingPending=p;}
    if(this.serverActivity){this.serverActivity={...this.serverActivity,proof:{pid,closed:false}};await durableRecord(this.store.path('runtime-activity.json'),this.serverActivity);}
  }
  private async captureNative(p:Pending):Promise<{pending:Pending;backup:Backup|null}>{
    const ack=await readNativeAck(this.store,p);let snapshot:Backup|null=null;
    if(ack.outcome==='verified-backup'){snapshot=await this.verifiedBackup(await this.store.load(p.to),p.migrationName);demand(snapshot.sha256===ack.sha256&&snapshot.metadata.schema===ack.source_schema,'Freshest native backup digest/schema mismatch');}
    else demand(!await exists(backupPath(this.store,p.migrationName)),'No-game-db acknowledgement unexpectedly has a backup file');
    return{pending:{...p,nativeAck:ack},backup:snapshot};
  }
  private bookkeep(action:()=>Promise<void>):Promise<void>{
    demand(!this.bookkeepingTask,'Runtime bookkeeping already active');
    const task=Promise.resolve().then(action).finally(()=>{if(this.bookkeepingTask===task)this.bookkeepingTask=undefined;});this.bookkeepingTask=task;return task;
  }
  ready(proof:ReadyProof):Promise<void>{return this.bookkeep(()=>this.prepareReady(proof));}
  private assertReadinessOwner(proof:ReadyProof){demand(this.runtime.ownsLiveChild(proof.pid)&&this.runtime.view().status==='starting','Owned native server ended/changed during readiness bookkeeping');}
  private async prepareReady(proof:ReadyProof){
    this.assertReadinessOwner(proof);
    demand(this.current&&proof.resources===this.store.root(this.current.id)&&proof.binary===this.runtime.runtimePaths().binary&&proof.pid===proof.healthProcess&&proof.listenerSeen,'Readiness does not identify the selected owned server');
    if(!this.transaction)return;
    let p=this.transaction;demand(p.phase==='starting'&&p.pid===proof.pid,'Owned startup PID differs from pending runtime');
    const native=await this.captureNative(p);this.assertReadinessOwner(proof);p={...native.pending,phase:'ready',readiness:{pid:proof.pid,healthProcess:proof.healthProcess,listenerSeen:true,binarySha256:this.current.binarySha256,selected:p.to}};await this.writePending(p);this.startingPending=p;this.assertReadinessOwner(proof);
    if(this.startAuthorization&&!equal(p.from,p.to)){
      demand(this.serverActivity&&this.serverActivity.state==='active','Healthy transition lost its active server fence');
      const receipt:Receipt={format:1,id:randomUUID(),kind:'transition',markerSha256:this.startAuthorization.receipt.markerSha256,previousSha256:this.startAuthorization.sha256,from:p.from,to:p.to,pendingId:p.id,fenceId:this.serverActivity.id,proof:{pending:p,nativeAck:p.nativeAck,readiness:{pid:proof.pid,healthProcess:proof.healthProcess,listenerSeen:true,binarySha256:this.current.binarySha256,selected:p.to}}};
      await this.fence.publish(receipt,'active',this.serverActivity);this.serverActivity=await this.fence.activity();this.assertReadinessOwner(proof);
    }
    this.assertReadinessOwner(proof);await this.archivePending(p);this.committed=this.current;
  }
  exposedReady(){
    this.startingPending=undefined;
    if(this.failure)this.update(this.failure.kind,`${this.failure.message}; playing verified installed ${this.current!.version}. No latest-version claim.`);
    else this.update('ready',`Installed ${this.current!.version} is running; owned readiness verified${this.current!.startupBackup===1?' with fresh under-lock backup':' (legacy source runtime has no guarded-start capability)'}. Previous failure evidence, if any, remains retained.`);
  }
  async startFailed(error:unknown):Promise<boolean>{
    if(this.startingPending){if(!this.transaction)await this.writePending(this.startingPending);this.problem(new UpdateProblem('recovery',`Guarded startup was not completed: ${String(error)}. Preserve fresh startup backup/ack and use explicit recovery.`));return true;}
    return !!this.transaction&&this.transaction.phase==='starting';
  }
  async cleanStop(result:{code:number|null;signal:string|null;pid:number}){
    demand(result.code===0&&result.signal===null,'No actual clean native close proof');
    if(this.bookkeepingTask)await this.bookkeepingTask.catch(()=>undefined);
    if(this.serverActivity){const activity=await this.fence.activity();demand(activity&&activity.id===this.serverActivity.id&&(activity.proof as {pid?:number})?.pid===result.pid,'Stopped native PID differs from active fence');await this.fence.clean(activity,{...result,closed:true,selected:activity.selected});this.serverActivity=undefined;}
    if(this.transaction&&this.transaction.phase==='starting')this.update('recovery','Server closed cleanly before update readiness bookkeeping completed. Startup intent is retained; no update success is claimed.');
    else if(!this.transaction)this.update(this.failure?.kind??'ready',`${this.failure?this.failure.message+'; ':''}Installed ${this.current!.version} retained. This owned server closed cleanly; earlier failure evidence, if any, remains unchanged.`);
  }
  async beforeSave(){
    await this.initialized();demand(this.current&&!this.transaction,'Save operations are blocked while guarded startup/update recovery is pending');await this.fence.requireClean(select(this.current));
  }
  async authorityStarting(_command:string,binary:string){
    demand(this.runtime.view().operation||this.runtime.view().status==='starting','Save authority requires the existing Runtime reservation');
    const allowed=[this.current?.id,this.transaction?.from.id,this.transaction?.to.id].filter((id):id is string=>!!id).map(id=>join(this.store.root(id),this.policy.target==='win32-x64'?'openrotmg.exe':'openrotmg'));
    demand(allowed.includes(binary),'Authority binary is not an installed/pending authenticated runtime');
    if(this.explicitRecovery)return;
    if(this.serverActivity){demand(this.runtime.view().pid,'Server fence has no live owned server');return;}
    const selected=this.transaction?.phase==='preparing'?this.transaction.from:this.current?select(this.current):undefined;demand(selected,'Authority has no selected runtime');
    this.authorityActivity=await this.fence.active('authority',selected,this.transaction?.id??null);
  }
  async authorityClosed(completion:AuthorityCompletion){
    if(this.explicitRecovery)this.recoveryAuthority=completion;
    if(this.authorityActivity){const activity=this.authorityActivity;this.authorityActivity=undefined;try{await this.fence.authorityFinished(activity,completion);}catch(error){this.runtime.blockAmbiguousSave(error as Error);throw error;}}
  }
  async failureAuthorized():Promise<boolean>{
    const pointer=await this.fence.pointer();if(!pointer)return false;
    const auth=await this.fence.authorization();if(!auth)return false;
    if(this.runtime.view().status==='starting'&&this.transaction&&['selected','starting'].includes(this.transaction.phase)&&equal(this.transaction.from,auth.receipt.to)&&this.startAuthorization?.sha256===auth.sha256)return true;
    const selected=selection(await record(this.store.path('runtime-selection.json')));await this.fence.requireClean(selected);return true;
  }
  async persistFailure(error:unknown){
    ++this.failureSerial;
    // Waiting for all of boot/recovery would deadlock its failure gate; only settle already-started durable bookkeeping before retirement.
    if(this.bookkeepingTask)await this.bookkeepingTask.catch(()=>undefined);
    const marker={format:1,id:randomUUID(),at:new Date().toISOString(),error:String(error)},data=Buffer.from(JSON.stringify(marker,null,2)+'\n'),sha=digest(data);
    const ownedPending=this.transaction??this.startingPending;
    if(ownedPending){await this.writePending({...ownedPending,failureSha256:sha});}
    await this.fence.retire(sha);
    const path=this.store.path('shutdown-failed.json');
    if(await exists(path)){
      const old=await boundedFile(path),directory=join(this.runtime.diagnostics,'failure-history');await mkdir(directory,{recursive:true,mode:0o700});const archived=join(directory,digest(old)+'.json');
      if(await exists(archived))demand((await boundedFile(archived)).equals(old),'Archived failure bytes changed');else await durableBytes(archived,old,true);
    }
    await durableBytes(path,data);
  }
  async retry():Promise<UpdateView>{
    return this.runtime.idleOperation('Explicitly retry quarantined runtime',async()=>{
      demand(this.staged&&!this.transaction,'No exact quarantined candidate is available');const g=await this.store.load(select(this.staged));
      if(!await this.confirm({kind:'retry-update',message:`Retry the exact failed runtime ${g.version}?`,detail:'This is an explicit retry, not an automatic replay. A new independent pre-update backup and fresh under-lock startup backup are required. No running game will be stopped.'})||this.runtime.view().closing)return this.view();
      this.failure=undefined;this.quarantined=false;await this.activateOwned(g,true);return this.view();
    });
  }
  async recover():Promise<UpdateView>{
    return this.runtime.recoveryOperation('Explicit local runtime recovery',async()=>{
      this.explicitRecovery=true;this.recoveryCompletion=undefined;this.recoveryAuthority=undefined;
      try{this.abort();if(this.task)await this.task;if(await exists(this.store.path('runtime-pending.json')))await this.restorePending();else await this.verifyCurrent();return this.view();}
      catch(error){
        const proof=this.recoveryCompletion as {command:string;ack:unknown}|undefined,problem=new UpdateProblem('recovery',`${proof?`Recovery ${proof.command} actual close0/strict acknowledgement=${JSON.stringify(proof.ack)}; `:''}${String(error)}. No unknown operation was replayed.`);this.problem(problem);throw problem;
      }
      finally{this.explicitRecovery=false;this.recoveryCompletion=undefined;this.recoveryAuthority=undefined;}
    });
  }
  private async finishRecovery(receipt:Receipt,sha:string,selected:Generation,failedCandidate?:Generation){
    await this.runtime.verifyFailureGate();const failureSerial=this.failureSerial,p=await readPending(this.store),current=selection(await record(this.store.path('runtime-selection.json')));
    demand(p.id===receipt.pendingId&&p.failureSha256===receipt.markerSha256&&p.recovery?.receiptSha256===sha&&await this.fence.markerSha256()===receipt.markerSha256,'Recovery completion was superseded by a new failure or changed pending proof');
    demand(equal(current,receipt.from)||equal(current,receipt.to),'Recovery completion has a foreign authoritative selection');
    demand(this.failureSerial===failureSerial,'A new failure superseded recovery finalization');
    await this.bookkeep(async()=>{
      await this.store.choose(selected);await this.fence.publish(receipt,'clean');
      if(failedCandidate){const profile=await this.store.profile();if(!profile.failed.includes(failedCandidate.id)){profile.failed.push(failedCandidate.id);await durableRecord(this.store.path('runtime-profile.json'),profile);}}
      const completed={...p,phase:'recovered' as const,recovery:{kind:receipt.kind,receiptSha256:sha}};await this.writePending(completed);await this.archivePending(completed);
      this.current=selected;this.committed=selected;this.runtime.selectResources(this.store.root(selected.id));
    });
    await this.runtime.verifyFailureGate();await this.runtime.completeUpdateRecovery(sha);this.initialization=Promise.resolve();this.failure=undefined;
  }
  private async restorePending(){
    let p=await readPending(this.store);const from=await this.store.load(p.from),candidate=await this.store.load(p.to);
    this.transaction=p;demand(p.kind==='start'||candidate.sequence>from.sequence,'Pending update does not advance the authenticated prior runtime');
    if((p.phase==='recovering'||p.phase==='recovered')&&typeof p.recovery?.receiptSha256==='string'){await this.finalizeRecordedRecovery(p);return;}
    if(p.phase==='ready'&&p.failureSha256===null){await this.finalizeRecordedReady(p);return;}
    if(p.kind==='start'&&p.phase==='starting'&&p.recovery===null&&await this.fence.pointer()){await this.verifyCurrent(p);return;}
    demand(['starting','ready'].includes(p.phase)&&p.recovery===null,'Interrupted recovery/selection requires manual investigation; no restore or migration replay was performed');
    demand(equal(selection(await record(this.store.path('runtime-selection.json'))),p.to),'Recovery selected generation is foreign to pending startup');
    this.transaction=p;
    if(p.failureSha256===null){
      if(await exists(this.store.path('shutdown-failed.json'))){const auth=await this.fence.authorization(),activity=await this.fence.activity();demand(auth&&activity&&activity.state==='active'&&activity.kind==='server'&&activity.pendingId===p.id&&activity.receiptSha256===auth.sha256&&equal(auth.receipt.to,p.from)&&equal(activity.from,p.from)&&equal(activity.selected,p.to),'An unrelated/preexisting shutdown failure cannot authorize updater recovery');}
      this.runtime.blockAmbiguousSave(new Error(`Interrupted updater-owned startup ${p.id}; completion unknown`));await this.runtime.verifyFailureGate();p=await readPending(this.store);
    }
    demand(p.failureSha256!==null&&await this.fence.markerSha256()===p.failureSha256,'Pending startup is not bound to this exact shutdown-failure marker');
    const native=await this.captureNative(p);p=native.pending;const input=native.backup;
    demand(input,'No game database existed before this interrupted startup. Current state and ack are retained; no stale/empty backup substitution or automatic rollback is allowed. Manual recovery is required.');
    const staged=await this.stageRecoveryInput(input);let receipt:Receipt|undefined,receiptSha:string|undefined,actualRestore:unknown,primary:unknown;
    try{
      const compatible=snapshotPreview(await saveAuthority(this.authority(from),'verify-snapshot',[staged.path,join(this.store.root(from.id),'data')]));demand(compatible.schema===input.metadata.schema,'Prior runtime cannot read freshest startup backup');
      if(!await this.confirm({kind:'restore-update',message:'Restore the freshest protected startup backup?',detail:`${backupPath(this.store,input.name)}\nSchema ${input.metadata.schema}; ${input.metadata.account_count} accounts; ${input.metadata.character_count} characters.\nRestore exact prior runtime ${from.version}. All current progress/credentials will be replaced ONLY after a separate verified pre-restore backup. Prior failure evidence and candidate are retained.`})||this.runtime.view().closing)return;
      const original=structuredClone(p),preName=fileName('pre-restore'),prePath=backupPath(this.store,preName),previous=await this.fence.pointer();
      if(previous)demand(previous.state==='retired'&&previous.markerSha256===p.failureSha256,'Prior recovery authorization is stale/foreign to this candidate failure');
      await this.writePending({...p,phase:'recovering',recovery:{kind:'restore',preRestoreName:preName,inputSha256:input.sha256}});
      actualRestore=await saveAuthority(this.authority(candidate),'restore',[this.runtime.runtimePaths().state,join(this.store.root(candidate.id),'data'),staged.path,prePath]);
      this.recoveryCompletion={command:'restore',ack:actualRestore};
      await this.writePending({...this.transaction!,recovery:{kind:'restore',preRestoreName:preName,inputSha256:input.sha256,ack:actualRestore}});
      const pre=await this.verifiedBackup(candidate,preName);
      receipt={format:1,id:randomUUID(),kind:'restore',markerSha256:p.failureSha256!,previousSha256:previous?.sha256??null,from:p.to,to:p.from,pendingId:p.id,fenceId:randomUUID(),proof:{pending:original,input,preRestore:pre,restoreAck:actualRestore,authority:p.to,close:{code:0,signal:null}}};
      receiptSha=await this.fence.remember(receipt);await this.fence.lineage(receiptSha);
      await this.writePending({...this.transaction!,recovery:{...this.transaction!.recovery,receiptSha256:receiptSha}});
    }catch(error){primary=error;throw new UpdateProblem('recovery',`${actualRestore===undefined?'':`Restore actual close0/strict acknowledgement=${JSON.stringify(actualRestore)}; `}${String(error)}. No restore replay is permitted.`);}
    finally{await this.store.cleanup(staged.stage,actualRestore===undefined?primary:`Restore actual close0/strict acknowledgement=${JSON.stringify(actualRestore)}; follow-up=${String(primary)}`);}
    demand(receipt&&receiptSha,'Recovery has no complete verified restore proof');
    await this.finishRecovery(receipt,receiptSha,from,p.kind==='update'?candidate:undefined);this.update('ready',`Recovered ${from.version} from the freshest verified startup backup. Previous failure evidence retained; failed candidate requires explicit retry or a newer release.`);
  }
  private async finalizeRecordedRecovery(p:Pending){
    const sha=p.recovery?.receiptSha256;demand(typeof sha==='string','Recovery has no exact completion receipt');
    const auth=await this.fence.lineage(sha),r=auth.receipt,current=selection(await record(this.store.path('runtime-selection.json'))),pointer=await this.fence.pointer();
    demand(['restore','current'].includes(r.kind)&&r.pendingId===p.id&&p.recovery?.kind===r.kind&&p.failureSha256===r.markerSha256&&await this.fence.markerSha256()===r.markerSha256,'Recorded recovery is foreign to pending/marker');
    demand(r.kind==='restore'?equal(r.from,p.to)&&equal(r.to,p.from):equal(r.to,p.to)&&equal(p.from,p.to),'Recorded recovery selection mismatch');
    demand(equal(current,r.from)||equal(current,r.to),'Recorded recovery has an unrelated current selection');
    if(pointer){demand(pointer.sha256===sha||pointer.sha256===r.previousSha256,'Recorded recovery predecessor pointer changed');if(pointer.sha256===sha)demand(pointer.state==='authorized'&&equal(current,r.to),'Published recovery selection changed');}
    const activity=await this.fence.activity();
    if(activity?.receiptSha256===sha){demand(activity.kind==='recovery'&&activity.state==='clean'&&activity.id===r.fenceId&&equal(activity.selected,r.to),'Recorded recovery fence was replaced by later work');}
    else if(r.previousSha256===null)demand(!activity,'Foreign activity appeared during first recovery');
    else{
      demand(activity?.receiptSha256===r.previousSha256,'Recorded recovery activity predecessor changed');
      if(r.kind==='current')demand(activity.kind==='authority'&&activity.state==='active'&&activity.id===r.fenceId&&activity.pendingId===p.id&&p.recovery?.repairActivityId===r.fenceId&&equal(activity.selected,r.to),'Current-save recovery repair activity changed');
      else demand(activity.pendingId===p.id&&equal(activity.selected,p.to),'Restore recovery activity belongs to another candidate');
    }
    if(!await this.confirm({kind:'verify-current',message:'Finalize the recorded completed recovery?',detail:'The exact Rust completion receipt is already durable. This only settles selection/authorization bookkeeping; it does NOT rerun restore or any unknown operation. Original failure and current/pre-restore backups remain retained.'})||this.runtime.view().closing)return;
    const selected=await this.store.load(r.to);await this.finishRecovery(r,sha,selected,r.kind==='restore'&&p.kind==='update'?await this.store.load(p.to):undefined);
    this.update('ready','Recorded recovery finalized without replay. Previous operation/failure evidence remains retained.');
  }
  private async finalizeRecordedReady(p:Pending){
    demand(p.readiness&&p.nativeAck&&p.failureSha256===null&&equal(selection(await record(this.store.path('runtime-selection.json'))),p.to),'Recorded ready startup has mismatched selection/proof');
    const selected=await this.store.load(p.to);demand(p.readiness.binarySha256===selected.binarySha256,'Recorded readiness binary changed');await this.captureNative(p);
    const pointer=await this.fence.pointer(),auth=pointer?await this.fence.authorization():undefined,activity=await this.fence.activity();
    if(pointer)demand(auth&&activity&&activity.kind==='server'&&activity.state==='active'&&activity.pendingId===p.id&&equal(activity.selected,p.to),'Interrupted transition has no exact active recovery fence');
    else demand(!activity&&!await exists(this.store.path('shutdown-failed.json')),'Unrelated failure cannot be blessed by recorded readiness');
    if(!await this.confirm({kind:'verify-current',message:'Keep the exact runtime that already reached verified readiness?',detail:'Recorded native backup and owned readiness prove startup completed before interruption. No migration or restore will be repeated. Previous server shutdown outcome remains unknown; recovered profiles must next validate and back up current progress before play.'})||this.runtime.view().closing)return;
    if(auth&&!equal(auth.receipt.to,p.to)){
      demand(equal(auth.receipt.to,p.from)&&activity?.receiptSha256===auth.sha256,'Transition predecessor differs from the recorded prior runtime');
      const r:Receipt={format:1,id:randomUUID(),kind:'transition',markerSha256:auth.receipt.markerSha256,previousSha256:auth.sha256,from:p.from,to:p.to,pendingId:p.id,fenceId:activity!.id,proof:{pending:p,nativeAck:p.nativeAck,readiness:p.readiness}};await this.fence.publish(r,'active',activity);
    }else if(auth&&!equal(p.from,p.to))demand(auth.receipt.kind==='transition'&&auth.receipt.pendingId===p.id,'Current transition receipt belongs to another startup');
    await this.archivePending(p);this.current=selected;this.committed=selected;this.runtime.selectResources(this.store.root(selected.id));this.initialization=Promise.resolve();
    if(auth){this.failure=new UpdateProblem('recovery','Recorded transition finalized; previous server lifetime remains unknown. Validate and back up current save explicitly; do not replay startup or restore ancient progress.');this.update('recovery',this.failure.message);}
    else{this.failure=undefined;this.update('ready','Exact runtime readiness was recorded before interruption. Previous shutdown outcome remains unknown; next Start still requires a fresh under-lock backup.');}
  }
  private async verifyCurrent(interrupted?:Pending){
    const failureSerial=this.failureSerial,pointer=await this.fence.pointer(),old=await this.fence.activity();demand(pointer&&old&&old.state==='active'&&pointer.sha256===old.receiptSha256,'No recovered-profile unknown activity is eligible for current-save verification');
    const markerSha=await this.fence.markerSha256();demand(pointer.markerSha256===markerSha,'Unknown activity recovery has a changed/foreign current failure marker');
    const auth=await this.fence.lineage(old.receiptSha256),selected=await this.store.load(selection(await record(this.store.path('runtime-selection.json'))));
    demand(equal(select(selected),old.selected)&&equal(select(selected),auth.receipt.to),'Current-save recovery cannot change runtime generation');
    let interruptedBytes:Buffer|undefined;
    if(interrupted){
      demand(interrupted.kind==='start'&&interrupted.phase==='starting'&&interrupted.recovery===null&&interrupted.readiness===null&&old.kind==='server'&&old.pendingId===interrupted.id&&equal(old.from,select(selected))&&equal(interrupted.from,select(selected))&&equal(interrupted.to,select(selected))&&(interrupted.failureSha256===null||interrupted.failureSha256===markerSha),'Pending work is not the exact interrupted ordinary same-generation startup');
      demand(selected.startupBackup===1&&selected.clientNamespace===1,'Interrupted current-save recovery requires the exact authorized capable runtime');
    }else demand(!await exists(this.store.path('runtime-pending.json')),'Pending migration/recovery forbids current-save recovery');
    if(!await this.confirm({kind:'verify-current',message:'Validate and back up the current local save?',detail:`The previous operation outcome remains UNKNOWN. This does not rerun it or restore ancient progress. The exact selected Rust authority must acquire StateLock and create and independently verify a fresh full snapshot.${interrupted?' The interrupted same-generation Start can only be settled if the current captured save is fully valid target schema22; this does NOT prove the old Start, migration or shutdown succeeded.':''}`})||this.runtime.view().closing)return;
    demand(equal(await this.fence.pointer(),pointer)&&equal(selection(await record(this.store.path('runtime-selection.json'))),select(selected))&&await this.fence.markerSha256()===markerSha&&this.failureSerial===failureSerial,'Recovery authorization/selection/failure changed during confirmation');
    const oldBytes=await boundedFile(this.store.path('runtime-activity.json'));demand(equal(JSON.parse(oldBytes.toString('utf8')),old),'Unknown activity changed during recovery confirmation');
    const oldSha=await this.fence.rememberBytes(oldBytes);
    if(interrupted){interruptedBytes=await boundedFile(this.store.path('runtime-pending.json'));demand(equal(pending(JSON.parse(interruptedBytes.toString('utf8'))),interrupted),'Interrupted startup changed during recovery confirmation');}
    const interruptedStartup=interruptedBytes?{sha256:await this.fence.rememberBytes(interruptedBytes),outcome:'unknown',settlement:'current-validation'}:null;
    const id=randomUUID(),activityId=randomUUID(),name=fileName('recovery-current');await mkdir(join(this.runtime.userData,'backups'),{recursive:true,mode:0o700});
    const intent:Pending={format:1,id,kind:'start',phase:'recovering',from:select(selected),to:select(selected),preBackup:null,noDatabase:false,migrationName:name,pid:null,nativeAck:null,readiness:null,failureSha256:markerSha,recovery:{kind:'current',oldActivitySha256:oldSha,previousSha256:auth.sha256,repairActivityId:activityId,interruptedStartup}};await this.writePending(intent);
    await this.fence.active('authority',select(selected),id,auth,activityId);
    let snapshot:{backup:Backup;ack:unknown};
    try{snapshot=await this.snapshot(selected,name);if(interrupted)demand(snapshot.backup.metadata.schema===22,'Interrupted same-generation startup remains UNKNOWN: current snapshot is not fully verified target schema22');}
    catch(error){
      const completion=this.recoveryAuthority;
      if(error instanceof AuthorityUnchangedError&&completion?.command==='snapshot'&&completion.outcome==='unchanged'&&completion.code!==0&&await this.fence.markerSha256()===markerSha&&this.failureSerial===failureSerial){
        await this.fence.remember({kind:'current-validation-refused',intent,completion:{...completion,signal:null,closed:true}});
        if(interruptedBytes){await durableBytes(this.store.path('runtime-pending.json'),interruptedBytes);this.transaction=interrupted;await durableBytes(this.store.path('runtime-activity.json'),oldBytes);}
        else{await durableBytes(this.store.path('runtime-activity.json'),oldBytes);await this.archivePending(await readPending(this.store));}
      }
      throw error;
    }
    const receipt:Receipt={format:1,id:randomUUID(),kind:'current',markerSha256:markerSha,previousSha256:auth.sha256,from:select(selected),to:select(selected),pendingId:id,fenceId:activityId,proof:{oldActivitySha256:oldSha,interruptedStartup,snapshot:snapshot.backup,snapshotAck:snapshot.ack,verification:{operation:'verify-snapshot',ack:snapshot.backup.metadata,sha256:snapshot.backup.sha256,close:{code:0,signal:null}},authority:select(selected),close:{code:0,signal:null}}};
    await this.runtime.verifyFailureGate();demand(await this.fence.markerSha256()===markerSha&&(await readPending(this.store)).failureSha256===markerSha,'Current-save validation was superseded by a new failure; no old authorization can mask it');
    const sha=await this.fence.remember(receipt);await this.fence.lineage(sha);await this.writePending({...intent,recovery:{...intent.recovery,receiptSha256:sha}});await this.finishRecovery(receipt,sha,selected);
    this.update('ready','Current save verified and independently backed up. Previous operation/start/migration/shutdown outcome remains UNKNOWN; no replay or rollback occurred. All current progress, interrupted intent and original failure/predecessor evidence remain retained.');
  }
  async verifyRecoveryComplete(sha:string){
    demand(!await exists(this.store.path('runtime-pending.json')),'Recovery bookkeeping remains pending');const selected=selection(await record(this.store.path('runtime-selection.json'))),auth=await this.fence.requireClean(selected);demand(auth?.sha256===sha,'Recovery acknowledgement does not match current marker/selection/fence');
  }
  recoveryAcknowledged(){this.startingPending=undefined;this.startAuthorization=undefined;this.authorityActivity=undefined;this.serverActivity=undefined;}
  canCancelStart(){return !this.startingPending&&(!this.transaction||['preparing','selected'].includes(this.transaction.phase));}
  canceledBeforeSpawn(){return new UpdateProblem('canceled','Launcher closing: startup canceled before any server invocation. Pending selection is retained; no migration/shutdown success is claimed.');}
  abort(){this.controller?.abort();}
  async settle(){if(this.task)await this.task;if(this.initialization)await this.initialization.catch(()=>undefined);}
}
