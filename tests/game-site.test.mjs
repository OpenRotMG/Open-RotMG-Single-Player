import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {copyFile} from 'node:fs/promises';
import {gameSite} from '../dist/game-site.js';

test('local game shell preserves runtime assets, API, WS and cache behavior behind strict loopback origins',async()=>{
 for(const file of ['game.html','game.css'])await copyFile('src/'+file,'dist/'+file);
 const backendSockets=new Set();
 const calls=[],namespace='/_runtime/'+'a'.repeat(64)+'/',bytes=Buffer.from([0,1,2,255]);let status='stopped',selectedPath=namespace;
 const backend=createServer((req,res)=>{calls.push({url:req.url,origin:req.headers.origin,host:req.headers.host});if(req.headers['if-none-match']==='"signed-asset"'){res.writeHead(304,{etag:'"signed-asset"'});res.end();return;}res.writeHead(200,{etag:'"signed-asset"','cache-control':'public, max-age=3600'});res.end(bytes);});
 backend.on('connection',socket=>{backendSockets.add(socket);socket.on('close',()=>backendSockets.delete(socket));});
 backend.on('upgrade',(req,socket,head)=>{calls.push({url:req.url,origin:req.headers.origin});socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');socket.on('data',chunk=>socket.write(chunk));if(head.length)socket.write(head);});
 await new Promise(ok=>backend.listen(0,'127.0.0.1',ok));const origin=`http://127.0.0.1:${backend.address().port}`;
 let site;
 try{
  site=await gameSite({origin,clientURL:()=>origin+selectedPath,view:()=>({status})},0);const url=site.url(),front=new URL(url).origin;
  assert.equal((await fetch(url)).status,503);status='ready';
  const page=await fetch(url),html=await page.text();assert.equal(page.status,200);assert.match(html,/Singleplayer/);assert(!html.includes('Pixel editor'));assert.match(html,/src="launcher.js"/);assert.equal(page.headers.get('cache-control'),'no-store');assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(page.headers.get('content-security-policy'),/style-src 'self' 'unsafe-inline'/);
  assert.match(await(await fetch(front+'/singleplayer.css')).text(),/#cb8585|#c3c3b9/);
  assert.equal((await fetch(front+'/',{redirect:'manual'})).headers.get('location'),namespace);
  assert.equal((await fetch(url,{headers:{origin:'https://evil.invalid'}})).status,403);
  assert.equal(await new Promise((ok,bad)=>{const req=request(url,{headers:{host:'evil.invalid'}},res=>{res.resume();ok(res.statusCode);});req.on('error',bad);req.end();}),403);
  for(const path of ['/health','/admin','/_runtime/'+'b'.repeat(64)+'/client.swf',namespace+'index.html'])assert.equal((await fetch(front+path)).status,404);
  assert.equal(calls.length,0);
  const asset=await fetch(url+'client.swf');assert.deepEqual(Buffer.from(await asset.arrayBuffer()),bytes);assert.equal(asset.headers.get('etag'),'"signed-asset"');assert.equal(asset.headers.get('cache-control'),'public, max-age=3600');
  assert.equal((await fetch(url+'client.swf',{headers:{'if-none-match':'"signed-asset"'}})).status,304);
  await fetch(front+'/legacy-api/char/list',{method:'POST',headers:{origin:front},body:'unit'});assert.equal(calls.at(-1).origin,origin);assert.equal(calls.at(-1).host,new URL(origin).host);
  const upgrade=source=>new Promise((ok,bad)=>{const req=request(front+'/game',{headers:{connection:'Upgrade',upgrade:'websocket',origin:source}});req.on('error',bad);req.on('response',res=>{res.resume();ok(res.statusCode);});req.on('upgrade',(_res,socket)=>{socket.once('error',bad);socket.once('data',chunk=>{socket.destroy();ok(chunk.toString());});socket.write('unit websocket bytes');});req.end();});
  assert.equal(await upgrade('https://evil.invalid'),403);assert.equal(await upgrade(front),'unit websocket bytes');assert.equal(calls.at(-1).origin,origin);
  selectedPath='/';assert.equal(site.url(),front+'/');assert.equal((await fetch(front+'/',{redirect:'manual'})).status,200);
  for(const path of ['/launcher.js','/client.swf','/vendor/ruffle.js','/sfx/test.mp3'])assert.deepEqual(Buffer.from(await(await fetch(front+path)).arrayBuffer()),bytes);
  for(const path of ['/health','/admin','/index.html',namespace+'launcher.js'])assert.equal((await fetch(front+path)).status,404);
  selectedPath=namespace;status='stopped';assert.equal((await fetch(url)).status,503);
  for(const socket of backendSockets)socket.destroy();await new Promise(ok=>backend.close(ok));
  status='ready';assert.equal((await fetch(url+'client.swf')).status,502);
 }finally{await site?.close();for(const socket of backendSockets)socket.destroy();await new Promise(ok=>backend.close(ok));}
});
