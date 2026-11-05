import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {requireAvailableRuntimeSequence} from '../scripts/runtime-release-history.mjs';
import {REPOSITORY} from '../dist/update-format.js';

test('runtime-release-history serialized different-tag attempts cannot sign the same draft-reserved sequence',()=>{
 const {publicKey,privateKey}=generateKeyPairSync('ed25519'),pem=publicKey.export({type:'spki',format:'pem'}),bytes=Buffer.from(JSON.stringify({sequence:1,releaseId:10,tag:'v0.1.0'})),signature=sign(null,bytes,privateKey);
 const releases=[{id:10,tag_name:'v0.1.0',draft:false,body:'',assets:[{id:11,name:'runtime-linux-x64.json',size:bytes.length},{id:12,name:'runtime-linux-x64.json.sig',size:64}]}],historyReads=[],signed=[],reserved=[];
 const api=path=>{if(path===`repos/${REPOSITORY}/releases?per_page=100&page=1`){historyReads.push(structuredClone(releases));return Buffer.from(JSON.stringify(releases));}if(path.endsWith('/assets/11'))return bytes;if(path.endsWith('/assets/12'))return signature;throw Error('Unexpected fixture API path: '+path);};
 const attempt=tag=>{requireAvailableRuntimeSequence(api,pem,tag,2);releases.push({id:20,tag_name:tag,draft:true,body:'RUNTIME_SEQUENCE=2\nCANDIDATE_SHA=fixture\n',assets:[]});reserved.push(tag);signed.push(tag);};
 // The workflow lock spans validation through upload; simulate its two sequential occupants, not real GitHub/signing.
 attempt('v0.1.1');assert.throws(()=>attempt('v0.1.2'),/must exceed every authenticated or draft-reserved sequence/);
 assert.deepEqual(reserved,['v0.1.1']);assert.deepEqual(signed,['v0.1.1']);assert.equal(historyReads.length,2);assert.equal(historyReads[1][1].draft,true);assert.equal(historyReads[1][1].body.split('\n')[0],'RUNTIME_SEQUENCE=2');
});
