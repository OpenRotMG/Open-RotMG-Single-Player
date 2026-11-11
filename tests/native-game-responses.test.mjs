import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {accountResponses} from '../scripts/native-game.mjs';
const origin='http://127.0.0.1:47832';
function fixture(){
 const page=new EventEmitter(),errors=[];let url='about:blank',verified=0,characters=0,hasCharacter=false;
 const frame={url:()=>url};page.mainFrame=()=>frame;page.goto=async next=>{url=next;page.emit('framenavigated',frame);};
 const observer=accountResponses(page,{origin,normalCache:true,onNavigation:()=>{verified=0;characters=0;hasCharacter=false;errors.length=0;},onVerify:()=>verified++,onCharacters:value=>{characters++;hasCharacter=value;},onError:error=>errors.push(error)});
 const request=(path='/legacy-api/char/list')=>{const r={url:()=>origin+path};page.emit('request',r);return r;};
 const response=(r,text=async()=>'<Chars><Char id="1"></Char></Chars>',finished=async()=>null)=>page.listeners('response')[0]({url:r.url,request:()=>r,text,finished});
 return{page,frame,observer,errors,request,response,state:()=>({verified,characters,hasCharacter})};
}
test('account evidence ignores old-document responses arriving after the next real navigation commit',async()=>{
 const f=fixture();await f.observer.navigate(origin+'/');const old=f.request();await f.observer.navigate(origin+'/next/');let read=false;await f.response(old,async()=>{read=true;throw Error('body no longer exists');});assert.equal(read,false);assert.deepEqual(f.errors,[]);assert.equal(f.state().characters,0);await f.response(f.request());assert.deepEqual(f.state(),{verified:0,characters:1,hasCharacter:true});
});
test('account body read already pending during reload cannot contaminate the new document',async()=>{
 const f=fixture();await f.observer.navigate(origin+'/');let reject,entered;const body=new Promise((_,bad)=>reject=bad),reading=new Promise(ok=>entered=ok);const response=f.response(f.request(),()=>{entered();return body;});await reading;await f.observer.navigate(origin+'/next/');reject(Error('No resource with given identifier found'));await response;assert.deepEqual(f.errors,[]);assert.equal(f.state().characters,0);
});
test('current-document missing bodies and unobserved requests remain explicit errors, never successful evidence',async()=>{
 const f=fixture();await f.observer.navigate(origin+'/');await f.response(f.request(),async()=>{throw Error('body unavailable');});assert.match(f.errors[0],/body unavailable/);assert.equal(f.state().characters,0);await f.response({url:()=>origin+'/legacy-api/char/list'});assert.match(f.errors[1],/no observed request generation/);
});
test('unexpected main-frame navigation remains a failure rather than clearing prior verification errors',async()=>{
 const f=fixture();await f.observer.navigate(origin+'/');await f.response(f.request('/legacy-api/account/verify'));assert.equal(f.state().verified,1);f.page.emit('framenavigated',f.frame);assert.match(f.errors[0],/Unplanned main-frame navigation/);
});
