import {join} from 'node:path';
import {SnapshotPreview,snapshotPreview} from './saves';
import {demand,exact,hex,integer,portablePath,runtimeSaveSchema} from './update-format';
import {boundedFile,record,RuntimeStore,Selection,selection} from './update-store';

export type Backup={name:string;sha256:string;metadata:SnapshotPreview;authority:Selection};
export type NativeStartupAck={protocol:1;operation:'pre-migration';process:number;backup:string;sha256:string|null;source_schema:21|22|23|null;target_schema:22|23;outcome:'verified-backup'|'no-game-db'};
export type ReadinessRecord={pid:number;healthProcess:number;listenerSeen:true;binarySha256:string;selected:Selection};
export type Pending={format:1;id:string;kind:'update'|'start';phase:'preparing'|'selected'|'starting'|'ready'|'recovering'|'recovered';from:Selection;to:Selection;preBackup:Backup|null;noDatabase:boolean;migrationName:string;pid:number|null;nativeAck:NativeStartupAck|null;readiness:ReadinessRecord|null;failureSha256:string|null;recovery:Record<string,unknown>|null};
export const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export function backupName(value:unknown):asserts value is string{portablePath(value);demand(!value.includes('/')&&value.endsWith('.sqlite'),'Invalid fixed local backup name');}
export function backup(value:unknown):Backup{
  exact(value,'name,sha256,metadata,authority','verified local backup');backupName(value.name);demand(hex(value.sha256),'Invalid local backup digest');snapshotPreview(value.metadata);selection(value.authority);return value as unknown as Backup;
}
export function nativeAck(value:unknown,path:string,pid:number,schema:22|23=22):NativeStartupAck{
  exact(value,'protocol,operation,process,backup,sha256,source_schema,target_schema,outcome','native pre-migration acknowledgement');
  demand(value.protocol===1&&value.operation==='pre-migration'&&integer(pid,1)&&value.process===pid&&value.backup===path&&value.target_schema===schema,'Native startup acknowledgement ownership/path/protocol mismatch');
  demand((value.outcome==='verified-backup'&&hex(value.sha256)&&(value.source_schema===21||value.source_schema===22||value.source_schema===23)&&Number(value.source_schema)<=schema)||(value.outcome==='no-game-db'&&value.sha256===null&&value.source_schema===null),'Invalid native backup/no-game-db acknowledgement');return value as unknown as NativeStartupAck;
}
export function pending(value:unknown):Pending{
  exact(value,'format,id,kind,phase,from,to,preBackup,noDatabase,migrationName,pid,nativeAck,readiness,failureSha256,recovery','runtime pending journal');
  demand(value.format===1&&uuid(value.id)&&['update','start'].includes(String(value.kind))&&['preparing','selected','starting','ready','recovering','recovered'].includes(String(value.phase)),'Invalid pending runtime transaction');
  selection(value.from);selection(value.to);if(value.preBackup!==null)backup(value.preBackup);backupName(value.migrationName);
  demand(typeof value.noDatabase==='boolean'&&(value.pid===null||integer(value.pid,1))&&(value.failureSha256===null||hex(value.failureSha256))&&(value.recovery===null||typeof value.recovery==='object'&&!Array.isArray(value.recovery)),'Invalid pending runtime proof fields');
  if(value.kind==='start')demand(JSON.stringify(value.from)===JSON.stringify(value.to),'Ordinary startup cannot change generation');
  if(value.nativeAck!==null)demand(value.pid!==null,'Native acknowledgement has no durably owned PID');
  if(value.readiness!==null){exact(value.readiness,'pid,healthProcess,listenerSeen,binarySha256,selected','pending owned readiness');demand(integer(value.readiness.pid,1)&&value.readiness.pid===value.pid&&value.readiness.healthProcess===value.pid&&value.readiness.listenerSeen===true&&hex(value.readiness.binarySha256)&&JSON.stringify(selection(value.readiness.selected))===JSON.stringify(value.to),'Pending readiness is foreign to owned startup');}
  if(value.phase==='ready')demand(value.readiness!==null&&value.nativeAck!==null,'Ready journal lacks native startup/readiness proof');
  return value as unknown as Pending;
}
export async function readPending(store:RuntimeStore):Promise<Pending>{return pending(await record(store.path('runtime-pending.json')));}
export const backupPath=(store:RuntimeStore,name:string)=>{backupName(name);return join(store.userData,'backups',name);};
export async function readNativeAck(store:RuntimeStore,p:Pending):Promise<NativeStartupAck>{
  demand(p.pid!==null,'Startup was interrupted before owned PID proof became durable; no automatic migration replay or backup substitution is allowed');
  const path=backupPath(store,p.migrationName),bytes=await boundedFile(path+'.ack.json',16*1024);
  let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw Error('Native startup acknowledgement is not bounded UTF-8 JSON');}
  return nativeAck(value,path,p.pid,await runtimeSaveSchema(store.root(p.to.id)));
}
