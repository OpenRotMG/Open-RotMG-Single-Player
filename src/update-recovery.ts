import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {AuthorityCompletion} from './runtime';
import {backup,Backup,backupPath,NativeStartupAck,nativeAck,Pending,pending,uuid} from './update-journal';
import {boundedFile,demand,digest,exact,hex,integer,UpdateProblem,runtimeSaveSchema} from './update-format';
import {exists,record,RuntimeStore,Selection,selection} from './update-store';

export type ReadyProof={pid:number;binary:string;resources:string;healthProcess:number;listenerSeen:true};
// The first restore has no authorization receipt yet; only its failure-bound ACTIVE recovery intent may have no root.
export type Activity={format:1;id:string;receiptSha256:string|null;kind:'server'|'authority'|'recovery';state:'active'|'clean';from:Selection;selected:Selection;pendingId:string|null;proof:unknown};
export type Receipt={format:1;id:string;kind:'restore'|'current'|'transition';markerSha256:string;previousSha256:string|null;from:Selection;to:Selection;pendingId:string;fenceId:string;proof:Record<string,unknown>};
export type Authorization={sha256:string;receipt:Receipt};
const bytes=(value:unknown)=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export class RecoveredRuntimeFence{
  constructor(private store:RuntimeStore){}
  private get history(){return join(this.store.userData,'runtime-recovery-history');}
  private historyPath(sha:string){demand(hex(sha),'Invalid recovery evidence digest');return join(this.history,sha+'.json');}
  async remember(value:unknown):Promise<string>{return this.rememberBytes(bytes(value));}
  async rememberBytes(data:Buffer):Promise<string>{
    const sha=digest(data);await this.store.container(this.history);const path=this.historyPath(sha);
    if(await exists(path))demand((await boundedFile(path)).equals(data),'Immutable recovery evidence changed');else await this.store.writeBytes(path,data,true);return sha;
  }
  async evidence(sha:string):Promise<unknown>{const data=await boundedFile(this.historyPath(sha));demand(digest(data)===sha,'Recovery predecessor/evidence digest mismatch');return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}
  async markerSha256(){return digest(await boundedFile(this.store.path('shutdown-failed.json')));}
  private async markerEvidence(sha:string){
    const current=this.store.path('shutdown-failed.json');if(await exists(current)&&digest(await boundedFile(current))===sha)return;
    const old=join(this.store.userData,'diagnostics','failure-history',sha+'.json');demand(digest(await boundedFile(old))===sha,'Original shutdown-failure evidence is missing or changed');
  }
  async pointer():Promise<{format:1;state:'authorized'|'retired';sha256:string;markerSha256:string}|undefined>{
    if(!await exists(this.store.path('runtime-recovery.json')))return undefined;
    const p=await record(this.store.path('runtime-recovery.json'));exact(p,'format,state,sha256,markerSha256','recovery authorization pointer');demand(p.format===1&&['authorized','retired'].includes(String(p.state))&&hex(p.sha256)&&hex(p.markerSha256),'Invalid recovery authorization pointer');return p as {format:1;state:'authorized'|'retired';sha256:string;markerSha256:string};
  }
  async activity():Promise<Activity|undefined>{
    if(!await exists(this.store.path('runtime-activity.json')))return undefined;
    return this.checkedActivity(await record(this.store.path('runtime-activity.json')));
  }
  private checkedActivity(value:unknown):Activity{
    exact(value,'format,id,receiptSha256,kind,state,from,selected,pendingId,proof','recovered-profile activity fence');
    demand(value.format===1&&uuid(value.id)&&(hex(value.receiptSha256)||value.receiptSha256===null&&value.kind==='recovery'&&value.state==='active')&&['server','authority','recovery'].includes(String(value.kind))&&['active','clean'].includes(String(value.state))&&(value.pendingId===null||uuid(value.pendingId)),'Invalid recovered-profile activity fence');selection(value.from);selection(value.selected);return value as unknown as Activity;
  }
  async lineage(sha:string):Promise<Authorization>{
    const chain:Authorization[]=[],seen=new Set<string>();let next:string|null=sha;
    while(next!==null){
      demand(!seen.has(next)&&seen.size<10_000,'Cyclic or excessive recovery history');seen.add(next);
      const value=await this.evidence(next);exact(value,'format,id,kind,markerSha256,previousSha256,from,to,pendingId,fenceId,proof','recovery receipt');
      demand(value.format===1&&uuid(value.id)&&['restore','current','transition'].includes(String(value.kind))&&hex(value.markerSha256)&&(value.previousSha256===null||hex(value.previousSha256))&&uuid(value.pendingId)&&uuid(value.fenceId),'Invalid recovery receipt identity');selection(value.from);selection(value.to);
      demand(value.proof!==null&&typeof value.proof==='object'&&!Array.isArray(value.proof),'Missing recovery proof');const r=value as unknown as Receipt;
      await this.store.load(r.from);await this.store.load(r.to);await this.markerEvidence(r.markerSha256);chain.push({sha256:next,receipt:r});next=r.previousSha256;
    }
    for(let i=chain.length-1;i>=0;i--){
      const r=chain[i].receipt,previous=chain[i+1];
      if(r.kind==='restore'){
        exact(r.proof,'pending,input,preRestore,restoreAck,authority,close,intentSha256','restore proof');const p=pending(r.proof.pending),input=backup(r.proof.input),pre=backup(r.proof.preRestore);
        exact(r.proof.restoreAck,'restored,backup','actual restore acknowledgement');exact(r.proof.close,'code,signal','actual restore close');
        demand(p.id===r.pendingId&&p.failureSha256===r.markerSha256&&equal(p.to,r.from)&&equal(p.from,r.to)&&equal(r.proof.authority,p.to)&&p.nativeAck!==null&&p.pid!==null,'Restore proof is foreign to pending update');
        const ack=nativeAck(p.nativeAck,backupPath(this.store,p.migrationName),p.pid,await runtimeSaveSchema(this.store.root(p.to.id)));
        demand(ack.outcome==='verified-backup'&&input.name===p.migrationName&&input.sha256===ack.sha256&&input.metadata.schema===ack.source_schema&&equal(input.authority,p.to)&&equal(pre.authority,p.to),'Restore did not use the freshest verified under-lock snapshot');
        demand(r.proof.restoreAck.restored===true&&r.proof.restoreAck.backup===backupPath(this.store,pre.name)&&r.proof.close.code===0&&r.proof.close.signal===null,'Restore lacks actual successful close/strict acknowledgement');
        demand(hex(r.proof.intentSha256),'Restore has no exact write-ahead recovery intent');const intent=await this.evidence(r.proof.intentSha256);
        exact(intent,'format,id,pendingSha256,oldActivitySha256,markerSha256,previousSha256,selected,prior,candidate,backupName,backupSha256,activityId,target','restore recovery intent');
        demand(intent.format===1&&uuid(intent.id)&&intent.id!==p.id&&hex(intent.pendingSha256)&&(intent.oldActivitySha256===null||hex(intent.oldActivitySha256))&&intent.markerSha256===r.markerSha256&&intent.previousSha256===r.previousSha256&&intent.activityId===r.fenceId&&intent.target===this.store.policy.target&&equal(selection(intent.selected),p.to)&&equal(selection(intent.candidate),p.to)&&equal(selection(intent.prior),p.from)&&intent.backupName===input.name&&intent.backupSha256===input.sha256,'Restore recovery intent changed identity/backup/marker/selection');
        const original=pending(await this.evidence(intent.pendingSha256));demand(equal({...original,nativeAck:p.nativeAck},p)&&(original.nativeAck===null||equal(original.nativeAck,p.nativeAck)),'Restore recovery changed the exact failed pending intent');
        if(previous){demand(hex(intent.oldActivitySha256),'Recovered restore lost its old activity');const old=this.checkedActivity(await this.evidence(intent.oldActivitySha256));demand(old.receiptSha256===previous.sha256&&old.pendingId===p.id&&equal(old.selected,p.to),'Restore recovery old activity is foreign');}
        else demand(intent.oldActivitySha256===null,'First recovery cannot borrow an unrelated old activity');
        if(previous){
          const prior=previous.receipt,ownReadyTransition=prior.kind==='transition'&&prior.pendingId===p.id&&p.kind==='update'&&p.phase==='ready'&&equal(prior.from,p.from)&&equal(prior.to,p.to)&&equal(prior.proof.pending,{...p,failureSha256:null});
          demand(ownReadyTransition||prior.pendingId!==p.id&&equal(prior.to,p.from),'Restore predecessor selection mismatch or foreign completed transition');
        }
      }else if(r.kind==='current'){
        demand(previous,'Current-save recovery has no explicit recovered-profile lineage');exact(r.proof,'oldActivitySha256,interruptedStartup,snapshot,snapshotAck,verification,authority,close','current-save recovery proof');
        demand(hex(r.proof.oldActivitySha256),'Missing unknown activity proof');const old=this.checkedActivity(await this.evidence(r.proof.oldActivitySha256));const snapshot=backup(r.proof.snapshot);
        exact(r.proof.snapshotAck,'snapshot,verified','current snapshot acknowledgement');exact(r.proof.close,'code,signal','current snapshot close');
        demand(old.state==='active'&&r.fenceId!==old.id&&old.receiptSha256===previous.sha256&&equal(old.selected,previous.receipt.to)&&equal(r.from,r.to)&&equal(r.to,previous.receipt.to)&&equal(snapshot.authority,r.to)&&equal(r.proof.authority,r.to),'Current-save recovery changed generation or blessed unrelated work');
        demand(r.proof.snapshotAck.snapshot===backupPath(this.store,snapshot.name)&&r.proof.snapshotAck.verified===true&&r.proof.close.code===0&&r.proof.close.signal===null,'Current-save recovery lacks actual verified snapshot close');
        exact(r.proof.verification,'operation,ack,sha256,close','current snapshot verification proof');const verification=r.proof.verification;exact(verification.close,'code,signal','current snapshot verification close');
        demand(verification.operation==='verify-snapshot'&&equal(verification.ack,snapshot.metadata)&&verification.sha256===snapshot.sha256&&verification.close.code===0&&verification.close.signal===null,'Current-save recovery lacks the full snapshot verification close/digest proof');
        if(r.proof.interruptedStartup!==null){
          exact(r.proof.interruptedStartup,'sha256,outcome,settlement','interrupted ordinary startup disposition');const interrupted=r.proof.interruptedStartup;demand(hex(interrupted.sha256)&&interrupted.outcome==='unknown'&&interrupted.settlement==='current-validation','Interrupted startup outcome cannot be relabelled successful');
          const p=pending(await this.evidence(interrupted.sha256)),selected=await this.store.load(r.to);
          demand(p.kind==='start'&&p.phase==='starting'&&p.recovery===null&&p.readiness===null&&p.id===old.pendingId&&p.id!==r.pendingId&&old.kind==='server'&&equal(p.from,r.to)&&equal(p.to,r.to)&&equal(old.from,r.to)&&(p.failureSha256===null||p.failureSha256===r.markerSha256),'Current-save recovery is not the exact interrupted ordinary same-generation startup');
          demand(selected.startupBackup===1&&selected.clientNamespace===1&&snapshot.metadata.schema===await runtimeSaveSchema(this.store.root(selected.id)),'Interrupted startup requires a capable selected runtime and a fully verified current target-schema snapshot');
        }
      }else{
        demand(previous,'Healthy runtime transition has no recovery predecessor');exact(r.proof,'pending,nativeAck,readiness','healthy runtime transition proof');const p=pending(r.proof.pending);
        exact(r.proof.readiness,'pid,healthProcess,listenerSeen,binarySha256,selected','owned readiness proof');const ready=r.proof.readiness;
        demand(p.id===r.pendingId&&p.phase==='ready'&&p.failureSha256===null&&equal(p.from,previous.receipt.to)&&equal(p.from,r.from)&&equal(p.to,r.to)&&r.markerSha256===previous.receipt.markerSha256,'Transition changed recovery root or prior selection');
        demand(p.pid!==null&&equal(r.proof.nativeAck,p.nativeAck)&&equal(r.proof.readiness,p.readiness),'Transition native/readiness acknowledgement mismatch');nativeAck(r.proof.nativeAck,backupPath(this.store,p.migrationName),p.pid,await runtimeSaveSchema(this.store.root(p.to.id)));
        const candidate=await this.store.load(p.to);demand(ready.pid===p.pid&&ready.healthProcess===p.pid&&ready.listenerSeen===true&&ready.binarySha256===candidate.binarySha256&&equal(ready.selected,p.to),'Transition has no owned native readiness/migration proof');
      }
    }
    demand(chain.length>0&&chain.at(-1)!.receipt.kind==='restore','Recovery chain does not begin with a verified restore');return chain[0];
  }
  async authorization():Promise<Authorization|undefined>{
    const pointer=await this.pointer();if(!pointer)return undefined;
    demand(await this.markerSha256()===pointer.markerSha256,'Recovery authorization does not match current failure marker');
    const auth=await this.lineage(pointer.sha256);if(pointer.state==='retired')return undefined;
    demand(pointer.markerSha256===auth.receipt.markerSha256&&await this.markerSha256()===auth.receipt.markerSha256,'Recovery authorization does not match current failure marker');return auth;
  }
  async requireClean(selected:Selection):Promise<Authorization|undefined>{
    const auth=await this.authorization(),activity=await this.activity();
    if(!auth){demand(!activity,'Recovered activity exists without a valid authorization; explicit recovery required');return undefined;}
    demand(activity&&activity.state==='clean'&&activity.receiptSha256===auth.sha256&&equal(activity.selected,selected)&&equal(auth.receipt.to,selected),'Previous recovered-profile activity is unknown; validate and back up current save explicitly');
    if(activity.kind==='recovery'){exact(activity.proof,'receipt','recovery clean fence');demand(activity.id===auth.receipt.fenceId&&activity.proof.receipt===auth.sha256,'Recovery clean fence changed');}
    else if(activity.kind==='server'){
      exact(activity.proof,'pid,code,signal,closed,selected','actual server close proof');demand(integer(activity.proof.pid,1)&&activity.proof.code===0&&activity.proof.signal===null&&activity.proof.closed===true&&equal(activity.proof.selected,selected),'Server fence has no actual clean close proof');
    }else{
      exact(activity.proof,'command,binary,code,outcome,ack,closed','actual authority close proof');demand(activity.proof.closed===true&&typeof activity.proof.command==='string'&&typeof activity.proof.binary==='string'&&((activity.proof.code===0&&activity.proof.outcome==='success')||(integer(activity.proof.code,1)&&activity.proof.outcome==='unchanged')),'Authority fence has no strict completed/unchanged close proof');
      if(activity.proof.outcome==='unchanged'){exact(activity.proof.ack,'protocol,operation,outcome,error','authority unchanged fence');demand(activity.proof.ack.protocol===1&&activity.proof.ack.operation===activity.proof.command&&activity.proof.ack.outcome==='unchanged'&&typeof activity.proof.ack.error==='string','Authority unchanged fence mismatch');}
    }
    return auth;
  }
  async active(kind:'server'|'authority',selected:Selection,pendingId:string|null,authorized?:Authorization,id=randomUUID()):Promise<Activity|undefined>{
    const auth=authorized??await this.requireClean(selected);if(!auth)return undefined;
    demand(uuid(id),'Invalid recovered activity generation');const value:Activity={format:1,id,receiptSha256:auth.sha256,kind,state:'active',from:auth.receipt.to,selected,pendingId,proof:null};
    await this.store.writeRecord(this.store.path('runtime-activity.json'),value);return value;
  }
  async clean(activity:Activity,proof:unknown){
    const current=await this.activity();demand(current&&current.id===activity.id&&current.state==='active'&&current.receiptSha256===activity.receiptSha256,'Recovered activity changed before clean acknowledgement');
    await this.store.writeRecord(this.store.path('runtime-activity.json'),{...current,state:'clean',proof});
  }
  async retire(markerSha256:string){
    const pointer=await this.pointer();if(pointer)await this.store.writeRecord(this.store.path('runtime-recovery.json'),{...pointer,state:'retired',markerSha256});
  }
  async publish(receipt:Receipt,state:'active'|'clean',activity?:Activity):Promise<string>{
    const sha=await this.remember(receipt);await this.lineage(sha);
    if(activity){demand(activity.id===receipt.fenceId,'Recovery transition changed server generation');await this.store.writeRecord(this.store.path('runtime-activity.json'),{...activity,receiptSha256:sha,state});}
    else await this.store.writeRecord(this.store.path('runtime-activity.json'),{format:1,id:receipt.fenceId,receiptSha256:sha,kind:'recovery',state,from:receipt.to,selected:receipt.to,pendingId:null,proof:{receipt:sha}} satisfies Activity);
    await this.store.writeRecord(this.store.path('runtime-recovery.json'),{format:1,state:'authorized',sha256:sha,markerSha256:receipt.markerSha256});return sha;
  }
  async authorityFinished(activity:Activity,completion:AuthorityCompletion){
    try{await this.clean(activity,{...completion,closed:true});}
    catch(error){throw new UpdateProblem('recovery',`Authority ${completion.command} actual close ${completion.code}/${completion.outcome} was verified, acknowledgement=${JSON.stringify(completion.ack)}; recovered-profile fence could NOT be recorded: ${String(error)}. Do not replay the operation; current state and evidence must be verified.`);}
  }
}
