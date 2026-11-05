import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeAck,backupName} from '../dist/update-journal.js';

test('update-journal accepts only the exact owned native backup/no-game-db protocol',()=>{
 const path='/fixed/user/backups/fresh.sqlite',ack={protocol:1,operation:'pre-migration',process:123,backup:path,sha256:'a'.repeat(64),source_schema:21,target_schema:22,outcome:'verified-backup'};
 assert.deepEqual(nativeAck(ack,path,123),ack);assert.deepEqual(nativeAck({...ack,source_schema:22},path,123),{...ack,source_schema:22});
 assert.equal(nativeAck({...ack,outcome:'no-game-db',sha256:null,source_schema:null},path,123).outcome,'no-game-db');
 for(const mutate of [a=>a.protocol=2,a=>a.operation='snapshot',a=>a.process=124,a=>a.backup='/arbitrary',a=>a.target_schema=23,a=>a.source_schema='21',a=>a.sha256='x',a=>a.extra=true,a=>a.outcome='unknown',a=>a.source_schema=23,a=>a.outcome='no-game-db',a=>{a.outcome='no-game-db';a.sha256=null;},a=>delete a.sha256]){const bad=structuredClone(ack);mutate(bad);assert.throws(()=>nativeAck(bad,path,123));}
 assert.throws(()=>nativeAck(ack,path,0));
});
test('update-journal never accepts arbitrary renderer paths as a journal-owned backup name',()=>{
 for(const name of ['/absolute.sqlite','../escape.sqlite','dir/file.sqlite','C:\\file.sqlite','file.sqlite:stream','file.json','con.sqlite'])assert.throws(()=>backupName(name));
 assert.doesNotThrow(()=>backupName('2026-11-05T00-00-00.000Z-pre-start-123.sqlite'));
});
