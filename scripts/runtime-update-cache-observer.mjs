import {createHash} from 'node:crypto';

export function observeRuntimeAssets({session,assets,errors,bodyTasks}){
 const requests=new Map();let order=0,overflow=false;
 const record=(requestId,event)=>{
  let state=requests.get(requestId);
  if(!state){
   if(requests.size===10000){if(!overflow)errors.push('Asset observer request retention limit exceeded; cache evidence incomplete');overflow=true;return;}
   state={eventOrder:[],wireStatus:null,servedFromCache:false};requests.set(requestId,state);
  }
  state.eventOrder.push({event,order:++order});return state;
 };
 session.on('Network.requestServedFromCache',event=>{
  const state=record(event.requestId,'requestServedFromCache');if(!state)return;state.servedFromCache=true;if(state.item)state.item.servedFromCache=true;
 });
 session.on('Network.responseReceivedExtraInfo',event=>{
  const state=record(event.requestId,'responseReceivedExtraInfo');if(!state)return;state.wireStatus=event.statusCode;if(state.item){state.item.wireStatus=event.statusCode;state.item.extraInfo='received';}
 });
 session.on('Network.responseReceived',event=>{
  const response=event.response,u=new URL(response.url);if(u.origin!=='http://127.0.0.1:47831'||u.pathname.startsWith('/legacy-api')||u.pathname==='/health'||!/\.(js|wasm|swf)$/.test(u.pathname))return;
  const state=record(event.requestId,'responseReceived');if(!state)return;
  state.item={requestId:event.requestId,url:u.href,status:response.status,fromDiskCache:!!response.fromDiskCache,servedFromCache:state.servedFromCache,wireStatus:state.wireStatus,hasExtraInfo:typeof event.hasExtraInfo==='boolean'?event.hasExtraInfo:null,extraInfo:state.wireStatus!==null?'received':event.hasExtraInfo===true?'pending':event.hasExtraInfo===false?'not-expected':'unknown',eventOrder:state.eventOrder,body:'pending',lastModified:response.headers['Last-Modified']??response.headers['last-modified']??null,fromServiceWorker:!!response.fromServiceWorker,cacheControl:response.headers['Cache-Control']??response.headers['cache-control']??null};
 });
 session.on('Network.loadingFinished',event=>{
  const state=requests.get(event.requestId);if(!state?.item)return;record(event.requestId,'loadingFinished');const item=state.item;
  // CDP cache/ExtraInfo events can outlive body retrieval; keep the same report reference for this bounded session.
  bodyTasks.push(session.send('Network.getResponseBody',{requestId:event.requestId}).then(body=>{
   record(event.requestId,'bodyResolved');item.sha256=createHash('sha256').update(Buffer.from(body.body,body.base64Encoded?'base64':'utf8')).digest('hex');item.body='received';assets.push(item);
  },error=>{record(event.requestId,'bodyRejected');item.body='unavailable';errors.push('Observed asset body unavailable: '+String(error));}));
 });
}
