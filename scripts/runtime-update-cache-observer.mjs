import {createHash} from 'node:crypto';

export function observeRuntimeAssets({session,assets,errors,bodyTasks,origin}){
 if(new URL(origin).origin!==origin)throw Error('Asset observer requires an explicit origin');
 const requests=new Map();let order=0,overflow=false;
 const record=(requestId,event)=>{
  let state=requests.get(requestId);
  if(!state){
   if(requests.size===10000){if(!overflow)errors.push('Asset observer request retention limit exceeded; cache evidence incomplete');overflow=true;return;}
   state={eventOrder:[],wireStatus:null,servedFromCache:false};requests.set(requestId,state);
  }
  state.eventOrder.push({event,order:++order});return state;
 };
 const body=(requestId,state)=>{
  if(!state?.item||state.reading)return;state.reading=true;const item=state.item;record(requestId,'bodyReadRequested');
  bodyTasks.push(session.send('Network.getResponseBody',{requestId}).then(value=>{
   record(requestId,'bodyResolved');item.sha256=createHash('sha256').update(Buffer.from(value.body,value.base64Encoded?'base64':'utf8')).digest('hex');item.body='received';
  },error=>{record(requestId,'bodyRejected');item.body='unavailable';errors.push(`Observed asset body unavailable (${item.url}): ${String(error)}`);}));
 };
 session.on('Network.requestServedFromCache',event=>{
  const state=record(event.requestId,'requestServedFromCache');if(!state)return;state.servedFromCache=true;if(state.item)state.item.servedFromCache=true;
 });
 session.on('Network.responseReceivedExtraInfo',event=>{
  const state=record(event.requestId,'responseReceivedExtraInfo');if(!state)return;state.wireStatus=event.statusCode;if(state.item){state.item.wireStatus=event.statusCode;state.item.extraInfo='received';}
 });
 session.on('Network.responseReceived',event=>{
  const response=event.response,u=new URL(response.url);if(u.origin!==origin||u.pathname.startsWith('/legacy-api')||u.pathname==='/health'||!/\.(js|wasm|swf)$/.test(u.pathname))return;
  const state=record(event.requestId,'responseReceived');if(!state)return;
  state.item={requestId:event.requestId,url:u.href,status:response.status,fromDiskCache:!!response.fromDiskCache,servedFromCache:state.servedFromCache,wireStatus:state.wireStatus,hasExtraInfo:typeof event.hasExtraInfo==='boolean'?event.hasExtraInfo:null,extraInfo:state.wireStatus!==null?'received':event.hasExtraInfo===true?'pending':event.hasExtraInfo===false?'not-expected':'unknown',eventOrder:state.eventOrder,body:'pending',lastModified:response.headers['Last-Modified']??response.headers['last-modified']??null,fromServiceWorker:!!response.fromServiceWorker,cacheControl:response.headers['Cache-Control']??response.headers['cache-control']??null};
  // Keep incomplete observations visible; only a received body hash qualifies the resource.
  assets.push(state.item);
 });
 session.on('Network.loadingFinished',event=>record(event.requestId,'loadingFinished'));
 // Mac traces omit loadingFinished for WASM after native frames; document-bound reads preserve evidence without borrowing stale document bodies.
 return{captureLoadedBodies(prefix){for(const [id,state]of requests)if(state.item?.url.startsWith(prefix))body(id,state);}};
}
