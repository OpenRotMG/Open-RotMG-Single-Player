import test from 'node:test';
import assert from 'node:assert/strict';
import {LauncherUpdates} from '../dist/launcher-updates.js';
const repo='OpenRotMG/Open-RotMG-Single-Player';
const release=(version,extra={})=>({id:100,tag_name:'v'+version,url:`https://api.github.com/repos/${repo}/releases/100`,draft:false,prerelease:false,body:'LAUNCHER_VERSION='+version,assets:[{name:`openrotmg-singleplayer-${version}-linux-x64.zip`,size:123, browser_download_url:`https://github.com/${repo}/releases/download/v${version}/openrotmg-singleplayer-${version}-linux-x64.zip`}],...extra});
const fixture=(records,installed='0.1.1')=>new LauncherUpdates(installed,'linux-x64',async(url,options)=>{assert.equal(url,`https://api.github.com/repos/${repo}/releases?per_page=100`);assert.equal(options.redirect,'error');assert(options.signal instanceof AbortSignal);return new Response(JSON.stringify(records));});
test('launcher checks are independent of runtime-only releases, versioned, coalesced and never offer a downgrade',async()=>{
 const u=fixture([release('99.0.0',{body:'RUNTIME_SEQUENCE=99',assets:[]}),release('0.1.0',{body:'legacy release'}),release('0.1.2')]);
 assert.equal(u.check(),u.check());assert.equal((await u.check()).phase,'available');assert.equal(u.view().installed,'0.1.1');assert.equal(u.view().available,'0.1.2');assert.match(u.download(),/v0\.1\.2\/openrotmg-singleplayer-0\.1\.2-linux-x64.zip$/);
 for(const v of ['0.1.0','0.1.1']){const old=fixture([release(v)]);assert.equal((await old.check()).phase,'current');assert.throws(()=>old.download(),/Check for a newer launcher/);}
});
test('marked launcher releases must have matching versions and exact official download URLs; a broken newest release is not silently replaced',async()=>{
 for(const bad of [release('0.1.2',{tag_name:'v0.1.3'}),release('0.1.2',{url:'https://evil.invalid/releases/100'}),release('0.1.2',{assets:[]}),release('0.1.2',{assets:[{name:'openrotmg-singleplayer-0.1.2-linux-x64.zip',size:1,browser_download_url:'https://evil.invalid/a.zip'}]}),release('banana')]){
  const u=fixture([bad,release('0.1.0')]);assert.equal((await u.check()).phase,'error');assert.throws(()=>u.download());
 }
 const u=fixture([release('0.1.2',{draft:true}),release('0.1.3',{prerelease:true}),release('0.1.1')]);assert.equal((await u.check()).available,'0.1.1');
});
test('launcher failures and truncated/oversized lists never claim the app is current or retain a download',async()=>{
 for(const response of [new Response('',{status:503}),new Response('not json'),new Response('{}'),new Response('x'.repeat(2*1024*1024+1)),new Response('[]',{headers:{link:'<https://api.github.com/page2>; rel="next"'}})]){
  const u=new LauncherUpdates('0.1.1','linux-x64',async()=>response);assert.equal((await u.check()).phase,'error');assert.throws(()=>u.download());
 }
 const u=new LauncherUpdates('0.1.1','linux-x64',async()=>{throw Error('network unavailable');});assert.match((await u.check()).message,/network unavailable/);
});
