import assert from 'node:assert/strict';
import {authenticateManifest,REPOSITORY} from '../dist/update-format.js';

export function requireAvailableRuntimeSequence(api,publicKey,tag,sequence){
 let highest=0,finished=false;
 for(let page=1;page<=100;page++){
  const releases=JSON.parse(api(`repos/${REPOSITORY}/releases?per_page=100&page=${page}`));assert(Array.isArray(releases));
  for(const release of releases){
   assert.notEqual(release.tag_name,tag,'Release/tag already exists; inspect prior actions instead of replaying or clobbering');const reservation=/(?:^|\n)RUNTIME_SEQUENCE=([1-9][0-9]*)(?:\n|$)/.exec(release.body??'');if(reservation){const reserved=Number(reservation[1]);assert(Number.isSafeInteger(reserved));highest=Math.max(highest,reserved);}
   for(const asset of release.assets.filter(a=>/^runtime-(linux-x64|win32-x64|darwin-arm64)\.json$/.test(a.name))){const sig=release.assets.filter(a=>a.name===asset.name+'.sig');assert.equal(sig.length,1,'Existing signed metadata is incomplete; no new sequence may bypass it');assert(asset.size>0&&asset.size<=65536&&sig[0].size===64);assert(Number.isSafeInteger(asset.id)&&Number.isSafeInteger(sig[0].id));const bytes=api(`repos/${REPOSITORY}/releases/assets/${asset.id}`,'-H','Accept: application/octet-stream'),signature=api(`repos/${REPOSITORY}/releases/assets/${sig[0].id}`,'-H','Accept: application/octet-stream'),header=authenticateManifest(bytes,signature,publicKey,release.id,release.tag_name);highest=Math.max(highest,header.sequence);}
  }
  if(releases.length<100){finished=true;break;}
 }
 assert(finished,'Release history exceeds bounded review window');assert(sequence>highest,'Production sequence must exceed every authenticated or draft-reserved sequence');if(highest===0){assert.equal(sequence,1);assert.equal(tag,'v0.1.0');}
}
