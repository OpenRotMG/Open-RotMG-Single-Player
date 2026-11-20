import test from 'node:test';import assert from 'node:assert/strict';import {createServer,request} from 'node:http';import {copyFile} from 'node:fs/promises';
import {gameSite} from '../dist/game-site.js';import {joinURL,HOST_PORT} from '../dist/multiplayer.js';
test('join accepts pasted addresses and share links, defaulting to the hosting port',()=>{
 assert.equal(joinURL(' 192.168.1.20 '),`http://192.168.1.20:${HOST_PORT}/`);
 assert.equal(joinURL('192.168.1.20:5000'),'http://192.168.1.20:5000/');
 assert.equal(joinURL('https://a-b.trycloudflare.com'),'https://a-b.trycloudflare.com/');
 for(const bad of ['file:///etc/passwd','javascript://x','http://user:pw@host'])assert.throws(()=>joinURL(bad),/Enter an address/);
});
const send=(port,path,headers,method='POST')=>new Promise((ok,bad)=>{const req=request({host:'127.0.0.1',port,path,method,headers},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>ok({status:res.statusCode,body}));});req.on('error',bad);req.end();});
test('the hosting listener proxies same-origin friends with their own address and answers only the current reachability nonce',async()=>{
 for(const file of ['game.html','game.css','game-report.js'])await copyFile(`src/${file}`,`dist/${file}`);
 const seen=[],upstream=createServer((req,res)=>{seen.push(req.headers);res.end('ok');});await new Promise(ok=>upstream.listen(0,'127.0.0.1',ok));
 const origin=`http://127.0.0.1:${upstream.address().port}`,nonce='a'.repeat(32);
 const site=await gameSite({origin,clientURL:()=>origin+'/_runtime/x/',view:()=>({status:'ready'})},0,()=>{},()=>nonce);
 try{
  const port=await site.host(0),self=`127.0.0.1:${port}`;
  assert.deepEqual(await send(port,`/reachability/${nonce}`,{host:self},'GET'),{status:200,body:nonce});
  assert.equal((await send(port,`/reachability/${'b'.repeat(32)}`,{host:self},'GET')).status,404);
  assert.equal((await send(port,'/legacy-api/char/list',{host:self,origin:'http://evil.example'})).status,403);
  assert.equal((await send(port,'/legacy-api/char/list',{host:'friend.trycloudflare.com',origin:'https://friend.trycloudflare.com','cf-connecting-ip':'203.0.113.5','x-forwarded-for':'1.2.3.4'})).status,200);
  assert.equal(seen.at(-1)['x-forwarded-for'],'203.0.113.5');assert.equal(seen.at(-1).origin,origin);
  await send(port,'/legacy-api/char/list',{host:self,'x-forwarded-for':'1.2.3.4'});assert.equal(seen.at(-1)['x-forwarded-for'],'127.0.0.1');
  await site.unhost();await assert.rejects(send(port,'/',{host:self},'GET'));
 }finally{await site.close();upstream.close();}
});
