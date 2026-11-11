import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {observeRuntimeAssets} from '../scripts/runtime-update-cache-observer.mjs';

function fixture(origin='http://127.0.0.1:47831'){
 const session=new EventEmitter(),assets=[],errors=[],bodyTasks=[],bodies=new Map(),calls=[];
 session.send=(method,{requestId})=>{calls.push({method,requestId});return new Promise((resolve,reject)=>bodies.set(requestId,{resolve,reject}));};
 observeRuntimeAssets({session,assets,errors,bodyTasks,origin});
 const emit=(name,data={})=>session.emit('Network.'+name,{requestId:'warm',...data});
 const response=(fields={})=>emit('responseReceived',{hasExtraInfo:true,response:{url:'http://127.0.0.1:47831/launcher.js',status:200,headers:{'Last-Modified':'Thu, 05 Nov 2026 12:05:16 GMT'},...fields}});
 const finish=()=>emit('loadingFinished');
 const body=async()=>{bodies.get('warm').resolve({body:'old-A',base64Encoded:false});await Promise.all(bodyTasks);};
 return{session,assets,errors,bodyTasks,bodies,calls,emit,response,finish,body};
}
for(const timing of ['before response','after response','after loadingFinished','after body resolution'])for(const fact of ['wire304','servedFromCache'])test(`runtime-update-cache-observer retains ${fact} ${timing}`,async()=>{
 const f=fixture(),late=()=>fact==='wire304'?f.emit('responseReceivedExtraInfo',{statusCode:304}):f.emit('requestServedFromCache');
 if(timing==='before response')late();f.response();if(timing==='after response')late();f.finish();if(timing==='after loadingFinished')late();await f.body();const item=f.assets[0];if(timing==='after body resolution')late();
 assert.equal(f.assets.length,1);assert.equal(f.assets[0],item);assert.equal(item.sha256,createHash('sha256').update('old-A').digest('hex'));assert.equal(item.body,'received');assert.equal(item.hasExtraInfo,true);assert.equal(item.wireStatus,fact==='wire304'?304:null);assert.equal(item.extraInfo,fact==='wire304'?'received':'pending');assert.equal(item.servedFromCache,fact==='servedFromCache');assert.deepEqual(f.errors,[]);
 const names=item.eventOrder.map(e=>e.event),event=fact==='wire304'?'responseReceivedExtraInfo':'requestServedFromCache';assert.equal(names.filter(n=>n===event).length,1);if(timing==='after loadingFinished')assert(names.indexOf(event)>names.indexOf('loadingFinished'));if(timing==='after body resolution')assert(names.indexOf(event)>names.indexOf('bodyResolved'));assert.deepEqual(item.eventOrder.map(e=>e.order),item.eventOrder.map((_,i)=>i+1));
});

test('runtime-update-cache-observer preserves disk-cache and service-worker flags without fabricating wire status',async()=>{
 const f=fixture();f.response({fromDiskCache:true,fromServiceWorker:true});f.finish();await f.body();assert.equal(f.assets[0].fromDiskCache,true);assert.equal(f.assets[0].fromServiceWorker,true);assert.equal(f.assets[0].wireStatus,null);assert.equal(f.assets[0].servedFromCache,false);
});
test('runtime-update-cache-observer distinguishes pending, not-expected and unknown ExtraInfo',async()=>{
 for(const hasExtraInfo of [true,false,undefined]){
  const f=fixture();f.emit('responseReceived',{hasExtraInfo,response:{url:'http://127.0.0.1:47831/launcher.js',status:200,headers:{}}});f.finish();await f.body();assert.equal(f.assets[0].extraInfo,hasExtraInfo===true?'pending':hasExtraInfo===false?'not-expected':'unknown');assert.equal(f.assets[0].hasExtraInfo,hasExtraInfo??null);assert.equal(f.assets[0].wireStatus,null);assert.equal(f.assets[0].servedFromCache,false);
 }
});
test('runtime-update-cache-observer never treats absent facts, empty/matching bodies or wire200 as cache proof',async()=>{
 const driver=await readFile('scripts/runtime-updates-test.mjs','utf8'),expression="report.assets.some(r=>!r.url.includes('/_runtime/')&&(r.fromDiskCache||r.servedFromCache||r.wireStatus===304))";assert(driver.includes("check('Warm A resource cache was genuinely observed before C',"+expression+")"));const proof=new Function('report','return '+expression);
 assert.equal(proof({assets:[]}),false);for(const bytes of ['', 'old-A']){const f=fixture();f.response();f.finish();f.bodies.get('warm').resolve({body:bytes,base64Encoded:false});await Promise.all(f.bodyTasks);assert.equal(proof({assets:f.assets}),false);f.emit('responseReceivedExtraInfo',{statusCode:200});assert.equal(proof({assets:f.assets}),false);f.emit('responseReceivedExtraInfo',{statusCode:304});assert.equal(proof({assets:f.assets}),true);}
 assert.equal(proof({assets:[{url:'http://127.0.0.1:47831/_runtime/C/launcher.js',wireStatus:304}]}),false);
});
test('runtime-update-cache-observer follows the actual presentation origin, not a backend-only URL',async()=>{
 const f=fixture('http://127.0.0.1:47832');f.response({url:'http://127.0.0.1:47831/launcher.js'});f.finish();assert.deepEqual(f.calls,[]);f.response({url:'http://127.0.0.1:47832/launcher.js'});f.finish();await f.body();assert.equal(f.assets.length,1);assert.equal(f.assets[0].url,'http://127.0.0.1:47832/launcher.js');assert.deepEqual(f.errors,[]);
});
test('runtime-update-cache-observer keeps unavailable body an explicit failure, not a successful asset',async()=>{
 const f=fixture();f.response();f.finish();f.bodies.get('warm').reject(Error('body unavailable'));await Promise.all(f.bodyTasks);assert.deepEqual(f.assets,[]);assert.deepEqual(f.errors,['Observed asset body unavailable: Error: body unavailable']);
});
test('runtime-update-cache-observer ignores unrelated bodies and bounds retained requests with an explicit failure',()=>{
 const f=fixture();for(const url of ['http://example.invalid/launcher.js','http://127.0.0.1:47831/health','http://127.0.0.1:47831/legacy-api/char/list']){f.response({url});f.finish();}assert.deepEqual(f.calls,[]);
 for(let n=0;n<10002;n++)f.emit('responseReceivedExtraInfo',{requestId:String(n),statusCode:200});assert.deepEqual(f.errors,['Asset observer request retention limit exceeded; cache evidence incomplete']);
});
test('runtime-update-cache-observer direct source binding is identical in native case and promotion expected lists',async()=>{
 const driver=await readFile('scripts/runtime-updates-test.mjs','utf8'),promote=await readFile('scripts/promote-runtime.mjs','utf8');const native=driver.match(/const casePaths=(\[[^;]+\]);/)[1],expected=promote.match(/const sources=(\[[^;]+\]);/)[1];assert.equal(native,expected);assert(native.includes("'scripts/runtime-update-cache-observer.mjs'"));
});
