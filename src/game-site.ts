import {createServer, request, type IncomingMessage} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {Socket} from 'node:net';

// Presentation lives outside the authenticated runtime; its JS, SWF, assets and save authority stay byte-for-byte unchanged.
export async function gameSite(runtime:{origin:string;clientURL():string;view():{status:string}},port=47832){
  const [html,css]=await Promise.all(['game.html','game.css'].map(file=>readFile(join(__dirname,file))));
  const target=new URL(runtime.origin),sockets=new Set<Socket>();
  let origin:string;
  const trusted=(req:IncomingMessage)=>req.headers.host===new URL(origin).host&&(!req.headers.origin||req.headers.origin===origin);
  const prefix=()=>new URL(runtime.clientURL()).pathname;
  const headers=(req:IncomingMessage)=>({...req.headers,host:target.host,...(req.headers.origin?{origin:runtime.origin}:{})});
  const server=createServer((req,res)=>{
    if(!trusted(req)){res.writeHead(403);res.end('Unapproved local game origin');return;}
    if(runtime.view().status!=='ready'){res.writeHead(503,{'content-type':'text/plain'});res.end('Server is stopped. Start it in OpenRotMG Singleplayer.');return;}
    const url=new URL(req.url!,origin),path=url.pathname,base=prefix();
    if(req.method==='GET'&&path==='/'&&base!=='/'){ res.writeHead(302,{location:base});res.end();return;}
    if(req.method==='GET'&&(path===base||path==='/singleplayer.css')){
      res.writeHead(200,{'content-type':path===base?'text/html; charset=utf-8':'text/css; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});
      res.end(path===base?html:css);return;
    }
    const asset=base==='/'?['/launcher.js','/client.swf'].includes(path)||path.startsWith('/vendor/')||path.startsWith('/sfx/'):path.startsWith(base)&&path!==base+'index.html';
    if(!['GET','HEAD','POST'].includes(req.method!)||!(asset||path.startsWith('/legacy-api/'))){res.writeHead(404);res.end();return;}
    const proxy=request({hostname:target.hostname,port:target.port,path:req.url,method:req.method,headers:headers(req)},upstream=>{
      res.writeHead(upstream.statusCode!,upstream.headers);upstream.pipe(res);
      upstream.on('error',error=>res.destroy(error));
    });
    proxy.on('error',error=>{if(!res.headersSent)res.writeHead(502,{'content-type':'text/plain'});res.end(`Local game request failed: ${error.message}`);});
    req.on('aborted',()=>proxy.destroy());res.on('close',()=>proxy.destroy());req.pipe(proxy);
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  server.on('upgrade',(req,socket,head)=>{
    if(!trusted(req)||req.headers.origin!==origin||req.url!=='/game'||runtime.view().status!=='ready'){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    const proxy=request({hostname:target.hostname,port:target.port,path:'/game',headers:headers(req)});
    proxy.on('upgrade',(res,upstream,upstreamHead)=>{
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${res.rawHeaders.reduce((lines,value,i)=>lines+(i%2?value+'\r\n':value+': '),'')}\r\n`);
      if(upstreamHead.length)socket.write(upstreamHead);if(head.length)upstream.write(head);
      upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());
      socket.on('close',()=>upstream.destroy());upstream.on('close',()=>socket.destroy());socket.pipe(upstream).pipe(socket);
    });
    proxy.on('response',res=>{res.resume();socket.end(`HTTP/1.1 ${res.statusCode} Rejected\r\nConnection: close\r\n\r\n`);});
    proxy.on('error',()=>socket.destroy());socket.on('error',()=>proxy.destroy());proxy.end();
  });
  await new Promise<void>((ok,bad)=>{server.once('error',bad);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',bad);ok();});});
  const address=server.address();if(!address||typeof address==='string')throw new Error('Local game listener has no TCP address');
  origin=`http://127.0.0.1:${address.port}`;
  return{url:()=>origin+prefix(),close:()=>new Promise<void>((ok,bad)=>{server.close(error=>error?bad(error):ok());for(const socket of sockets)socket.destroy();})};
}
