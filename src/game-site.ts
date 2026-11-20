import {createServer, request, type IncomingMessage, type ServerResponse} from 'node:http';
import {readFile} from 'node:fs/promises';
import {isIP, type Socket} from 'node:net';
import {join} from 'node:path';

type Listener={server:ReturnType<typeof createServer>;sockets:Set<Socket>};
const LOOPBACK=new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);
/** The friend's address, so the server rate-limits each player instead of everyone as 127.0.0.1. Only the local share-link process may name another address. */
export function playerAddress(req:IncomingMessage){
  const peer=req.socket.remoteAddress!,named=req.headers['cf-connecting-ip'];
  return LOOPBACK.has(peer)&&typeof named==='string'&&isIP(named)?named:peer;
}

export async function gameSite(runtime:{origin:string;clientURL():string;view():{status:string}},port:number,onReport:(kind:string,message:string)=>void,reachability:()=>string|undefined=()=>undefined){
  const [html,css,reporter]=await Promise.all(['game.html','game.css','game-report.js'].map(file=>readFile(join(__dirname,file))));
  const target=new URL(runtime.origin);
  let origin:string,hosted:Listener|undefined;
  const local=(req:IncomingMessage)=>req.headers.host===new URL(origin).host&&(!req.headers.origin||req.headers.origin===origin);
  // Friends arrive by LAN address, public address or share-link name, so the hosting listener can only require same-origin requests.
  const sameOrigin=(req:IncomingMessage)=>{try{return Boolean(req.headers.host)&&(!req.headers.origin||new URL(req.headers.origin).host===req.headers.host);}catch{return false;}};
  const prefix=()=>new URL(runtime.clientURL()).pathname;
  const headers=(req:IncomingMessage)=>({...req.headers,host:target.host,'x-forwarded-for':playerAddress(req),...(req.headers.origin?{origin:runtime.origin}:{})});
  const handle=(trusted:(req:IncomingMessage)=>boolean)=>(req:IncomingMessage,res:ServerResponse)=>{
    if(!trusted(req)){res.writeHead(403);res.end('Unapproved game origin');return;}
    const nonce=/^\/reachability\/([0-9a-f]{32})$/.exec(req.url!)?.[1];
    if(req.method==='GET'&&nonce){const expected=reachability();res.writeHead(nonce===expected?200:404,{'content-type':'text/plain','cache-control':'no-store'});res.end(nonce===expected?nonce:'');return;}
    // Errors in the player's browser are otherwise invisible to the launcher and to bug reports.
    if(req.method==='POST'&&req.url==='/singleplayer-report'){
      let body='';req.setEncoding('utf8');req.on('data',chunk=>{body+=chunk;if(body.length>8192)req.destroy();});
      req.on('end',()=>{let value:{kind:unknown;message:unknown};try{value=JSON.parse(body);}catch{res.writeHead(400);res.end();return;}onReport(String(value.kind).slice(0,40),`${String(value.message).slice(0,2000)} (from ${playerAddress(req)})`);res.writeHead(204);res.end();});return;
    }
    if(req.method==='GET'&&req.url==='/singleplayer-report.js'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});res.end(reporter);return;}
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
  };
  const upgrade=(trusted:(req:IncomingMessage)=>boolean)=>(req:IncomingMessage,socket:Socket,head:Buffer)=>{
    if(!trusted(req)||!req.headers.origin||req.url!=='/game'||runtime.view().status!=='ready'){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    const proxy=request({hostname:target.hostname,port:target.port,path:'/game',headers:headers(req)});
    proxy.on('upgrade',(res,upstream,upstreamHead)=>{
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${res.rawHeaders.reduce((lines,value,i)=>lines+(i%2?value+'\r\n':value+': '),'')}\r\n`);
      if(upstreamHead.length)socket.write(upstreamHead);if(head.length)upstream.write(head);
      upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());
      socket.on('close',()=>upstream.destroy());upstream.on('close',()=>socket.destroy());socket.pipe(upstream).pipe(socket);
    });
    proxy.on('response',res=>{res.resume();socket.end(`HTTP/1.1 ${res.statusCode} Rejected\r\nConnection: close\r\n\r\n`);});
    proxy.on('error',()=>socket.destroy());socket.on('error',()=>proxy.destroy());proxy.end();
  };
  const listen=async(trusted:(req:IncomingMessage)=>boolean,address:string,listenPort:number):Promise<Listener>=>{
    const server=createServer(handle(trusted)),sockets=new Set<Socket>();
    server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
    server.on('upgrade',upgrade(trusted));
    await new Promise<void>((ok,bad)=>{server.once('error',bad);server.listen(listenPort,address,()=>{server.removeListener('error',bad);ok();});});
    return {server,sockets};
  };
  const closed=({server,sockets}:Listener)=>new Promise<void>((ok,bad)=>{server.close(error=>error?bad(error):ok());for(const socket of sockets)socket.destroy();});
  const loopback=await listen(local,'127.0.0.1',port);
  const address=loopback.server.address();if(!address||typeof address==='string')throw new Error('Local game listener has no TCP address');
  origin=`http://127.0.0.1:${address.port}`;
  return{
    url:()=>origin+prefix(),
    /** Opens the game to other computers; the operating system may ask the player to allow it through the firewall. */
    host:async(hostPort:number)=>{if(hosted)throw new Error('Already hosting');hosted=await listen(sameOrigin,'0.0.0.0',hostPort).catch(error=>{throw new Error(`Could not open port ${hostPort} for friends: ${error.message}`);});return (hosted.server.address() as {port:number}).port;},
    unhost:async()=>{const current=hosted;hosted=undefined;if(current)await closed(current);},
    close:async()=>{const current=hosted;hosted=undefined;await Promise.all([closed(loopback),...(current?[closed(current)]:[])]);},
  };
}
