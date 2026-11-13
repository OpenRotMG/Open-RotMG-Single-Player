import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { processArgv } from './process-argv.mjs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import {openNativeEdge,openNativeOwnedEdge} from './native-edge.mjs';

export function accountResponses(page,{origin,normalCache,onNavigation,onVerify,onCharacters,onError}){
 let generation=0,expectedURL;const requests=new WeakMap(),paths=['/legacy-api/account/verify','/legacy-api/char/list'];
 const relevant=url=>{const u=new URL(url);return u.origin===origin&&paths.includes(u.pathname);};
 page.on('framenavigated',frame=>{if(frame!==page.mainFrame())return;generation++;if(frame.url()!==expectedURL){onError('Unplanned main-frame navigation during account verification');return;}expectedURL=undefined;onNavigation();});
 // A previous document's response may arrive or lose its body after the next navigation commits.
 page.on('request',request=>{if(relevant(request.url()))requests.set(request,generation);});
 page.on('response',async response=>{
  if(!relevant(response.url()))return;const receivedIn=requests.get(response.request());if(receivedIn===undefined){onError('Account response has no observed request generation');return;}
  try{const error=await response.finished();if(receivedIn!==generation)return;if(error)onError(String(error));else if(new URL(response.url()).pathname.endsWith('/verify'))onVerify();else{const hasCharacter=normalCache?/<Char id="1">/.test(await response.text()):false;if(receivedIn===generation)onCharacters(hasCharacter);}}
  catch(error){if(receivedIn===generation)onError(String(error));}
 });
 return{async navigate(url){assert.equal(expectedURL,undefined,'Native account navigation overlaps');expectedURL=new URL(url).href;try{await page.goto(url);assert.equal(expectedURL,undefined,'Owned client navigation did not commit');}finally{expectedURL=undefined;}}};
}

const fixtureCredentials = { guid:'backup-true@example.invalid', password:'backup-fixture-password' };
export async function nativeGame({out,origin,env,check,report,ownedEdge,credentials = fixtureCredentials,normalCache = false,clientURL = origin,onPage}) {
  const mode=process.env.OPENROTMG_TEST_BROWSER_MODE;
  assert(['vps-managed','ci-playwright','ci-edge','ci-owned-edge'].includes(mode),'Select OPENROTMG_TEST_BROWSER_MODE=vps-managed, ci-playwright, ci-edge or ci-owned-edge explicitly');assert((mode==='ci-owned-edge')===!!ownedEdge,'ci-owned-edge requires only the prepared owned policy image');
  if(mode!=='vps-managed')assert(process.env.GITHUB_ACTIONS==='true','CI browser modes are restricted to GitHub Actions owned runners');
  else {
    assert(process.env.PI_BROWSER_TOOLS, 'PI_BROWSER_TOOLS must select the managed browser helper directory');
    assert(process.env.PI_NATIVE_TEST_CHROME, 'PI_NATIVE_TEST_CHROME must select the native Chrome binary');
  }
  report.browserMode=mode;
  let session, sequence=0, expected,entryURL=clientURL;
  const account = async name => {
    const response = await fetch(origin+'/legacy-api/char/list',{method:'POST',body:new URLSearchParams(credentials)});
    assert(response.ok,'Ordinary account read failed');
    const xml=await response.text();await writeFile(join(out,`${name}.xml`),xml);
    const character=/<Char id="1">([\s\S]*?)<\/Char>/.exec(xml);
    assert(character,'Synthetic character 1 missing');
    const equipment=/<Equipment>([^<]+)<\/Equipment>/.exec(character[1]);assert(equipment,'Character equipment missing');
    return equipment[1].split(',').map(Number);
  };
  const open = async name => {
    const owner=`single-player-package:${out}:${sequence++}`;
    const profile=join(out,'game-profile-'+sequence);
    let browser,context,page,chrome,edgeClose,errors='',consoleLog=[];
    if(mode==='vps-managed') {
      const probe=createServer();await new Promise(ok=>probe.listen(0,'127.0.0.1',ok));const port=probe.address().port;await new Promise(ok=>probe.close(ok));
      chrome=spawn(process.execPath,[join(process.env.PI_BROWSER_TOOLS,'launch-browser.mjs'),`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'--ozone-platform=x11','--window-size=1280,960','--window-position=0,0','--no-first-run','--no-default-browser-check',...JSON.parse(process.env.PI_NATIVE_TEST_CHROME_ARGS ?? '[]'),'about:blank'],{
        env:{...env,PI_BROWSER_OWNER:owner,PI_BROWSER_TAB_POLICY:'agent_only',CHROME_REAL_BINARY:process.env.PI_NATIVE_TEST_CHROME,CHROME_MCP_CPUQUOTA:'1600%'},stdio:['ignore','pipe','pipe']});
      let output='';chrome.stdout.on('data',bytes=>output+=bytes);chrome.stderr.on('data',bytes=>errors+=bytes);
      const deadline=Date.now()+30000;while(!output.includes('\n')&&Date.now()<deadline)await delay(100);
      assert(output.includes('\n'),`Managed browser receipt missing: ${errors}`);
      const receipt=JSON.parse(output.split('\n')[0]);assert(receipt.owner===owner&&receipt.pid===chrome.pid&&receipt.target,'Managed browser identity mismatch: '+JSON.stringify(receipt)+'; '+errors);
      const argv = await processArgv(receipt.pid);
      check(`${name}: managed browser argv has no sandbox or unsafe software-renderer bypass`, !/--no-sandbox|--disable-setuid-sandbox|--enable-unsafe-swiftshader|--disable-web-security|--disable-gpu-driver-bug-workarounds/.test(argv));
      (report.browsers??=[]).push({...receipt,argv});
      browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      context=browser.contexts()[0];page=context.pages()[0];assert(page,'Managed browser must create its initial owned page');
    } else if(mode==='ci-edge'||mode==='ci-owned-edge') {
      const options={owner,profile,env,report};({browser,context,page,close:edgeClose}=mode==='ci-owned-edge'?await openNativeOwnedEdge(options,ownedEdge):await openNativeEdge(options));
      check(`${name}: actual CI Edge argv has no sandbox bypass`,!/--no-sandbox|--disable-setuid-sandbox/.test(report.browsers.at(-1).argv));
    } else {
      const args=['--remote-debugging-pipe',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--window-size=1280,960',...(process.platform==='linux'?['--ozone-platform=x11']:[]),...JSON.parse(process.env.PI_NATIVE_TEST_CHROME_ARGS ?? '[]')];
      context=await chromium.launchPersistentContext(profile,{headless:false,chromiumSandbox:true,ignoreDefaultArgs:true,args,env,timeout:30000});
      browser=context.browser();page=context.pages()[0]??await context.newPage();
      const protocol=await browser.newBrowserCDPSession();
      const {processInfo}=await protocol.send('SystemInfo.getProcessInfo');
      const pid=processInfo.find(entry=>entry.type==='browser')?.id;
      assert(Number.isSafeInteger(pid),'Native CI browser PID must be observed');
      const argv=await processArgv(pid);
      check(`${name}: actual CI browser argv has no sandbox bypass`,!argv.includes('--no-sandbox')&&!argv.includes('--disable-setuid-sandbox'));
      (report.browsers??=[]).push({owner,pid,profile,argv});
    }
    report.gameBrowserVersion=browser.version();
    if(onPage)await onPage({page,browser,context,pid:report.browsers.at(-1).pid});
    // Playwright request interception disables HTTP caching; cache qualification observes normal requests instead.
    if(mode!=='ci-owned-edge'&&!normalCache)await page.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.origin===origin)return route.continue();
      (report.blockedBrowserRequests??=[]).push(url.origin);return route.abort('blockedbyclient');
    });
    page.on('console',message=>consoleLog.push({type:message.type(),text:message.text()}));
    page.on('pageerror',error=>consoleLog.push({type:'pageerror',text:String(error)}));
    let verified=0,charLists=0,playGeneration=0,currentAccountHasFixtureCharacter=false;
    const responseErrors=[],accountEvidence=accountResponses(page,{origin,normalCache,onNavigation:()=>{playGeneration++;verified=0;charLists=0;frames=0;currentAccountHasFixtureCharacter=false;responseErrors.length=0;consoleLog.length=0;},onVerify:()=>verified++,onCharacters:hasCharacter=>{currentAccountHasFixtureCharacter=hasCharacter;charLists++;},onError:error=>responseErrors.push(error)});
    const settled=async(predicate,label)=>{const deadline=Date.now()+30000;while(!predicate()&&Date.now()<deadline)await delay(100);assert(predicate(),label);assert.deepEqual(responseErrors,[]);await delay(500);await page.evaluate(()=>new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok))));};
    let frames=0;page.on('websocket',socket=>{const receivedIn=playGeneration;if(socket.url()===origin.replace('http:','ws:')+'/game')socket.on('framereceived',()=>{if(receivedIn===playGeneration)frames++;});});
    const close=async()=>{
      const failures=[];
      try{if(mode==='vps-managed'){
        const cdp=await browser.newBrowserCDPSession();await cdp.send('Browser.close');await browser.close();
        const deadline=Date.now()+10000;while(chrome.exitCode===null&&Date.now()<deadline)await delay(100);
        assert(chrome.exitCode===0,`Browser cleanup did not exit cleanly: ${chrome.exitCode}`);
      }else if(mode==='ci-edge'||mode==='ci-owned-edge')await edgeClose();
      else await context.close({timeout:10000});}catch(error){failures.push(error);}
      try{await writeFile(join(out,`${name}-browser.log`),errors+'\n'+JSON.stringify(consoleLog,null,2));}catch(error){failures.push(error);}
      if(failures.length)throw new AggregateError(failures,failures.map(error=>String(error.stack??error)).join('\n'));
    };
    const play=async(name)=>{
    try {
      assert.equal(new URL(entryURL).origin,origin,'Native client entry must stay on the fixed owned loopback server');
      await accountEvidence.navigate(entryURL);
      await page.waitForFunction(()=>document.querySelector('ruffle-player')?.ruffle().isPlaying===true,{},{timeout:60000});
      await delay(3000);
      await page.evaluate(()=>{const modal=document.querySelector('ruffle-player').shadowRoot.querySelector('#hardware-acceleration-modal');if(modal&&!modal.classList.contains('hidden'))modal.querySelector('.close-modal').click();});
      const rect=await page.locator('ruffle-player').boundingBox();assert(rect.width===800&&rect.height===600,'Unclipped native 800x600 game required');
      const click=async(x,y)=>page.mouse.click(rect.x+x,rect.y+y);
      if(normalCache){await settled(()=>charLists>=1,'Initial real account character response must settle before choosing sign-in');await click(400,300);await delay(300);}
      if(!currentAccountHasFixtureCharacter){
      await click(500,550);await delay(300);
      await click(400,438);await delay(300);
      await click(400,228);await page.keyboard.type(credentials.guid);
      await click(400,315);await page.keyboard.type(credentials.password);
      await click(492,420);await settled(()=>verified>=2,'Normal sign-in and Current account verification must finish');
      await click(480,386);await settled(()=>charLists>=2,'Post-login character refresh must finish before Play');
      }else check(`${name}: real remembered account authenticated character response observed`,charLists>=1&&currentAccountHasFixtureCharacter);
      await click(400,550);await delay(500);await page.evaluate(()=>new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok))));
      await click(160,130);
      const deadline=Date.now()+30000;while(frames<10&&Date.now()<deadline)await delay(100);
      check(`${name}: real client loaded character and received game updates`,frames>=10);
      await delay(1000);
      const renderer=consoleLog.find(entry=>/Created renderer/i.test(entry.text)||/Renderer:.*(?:WebGL|wgpu)/i.test(entry.text));
      await writeFile(join(out,`${name}-console.json`),JSON.stringify(consoleLog,null,2));
      check(`${name}: actual WebGL renderer (not Canvas)`,!!renderer&&!/Canvas/i.test(renderer.text));
      check(`${name}: no browser page exceptions`,!consoleLog.some(entry=>entry.type==='pageerror'));
      const graphics=await page.evaluate(()=>{
        const canvas=document.querySelector('ruffle-player')?.shadowRoot?.querySelector('canvas');
        if(!canvas)throw Error('Native game canvas missing');
        const gl=canvas.getContext('webgl2');if(!gl)throw Error('Native WebGL2 context missing');
        const extension=gl.getExtension('WEBGL_debug_renderer_info');
        return {webgl2:true,lost:gl.isContextLost(),renderer:gl.getParameter(gl.RENDERER),unmaskedRenderer:extension?gl.getParameter(extension.UNMASKED_RENDERER_WEBGL):null};
      });
      check(`${name}: live WebGL2 context is not lost`,graphics.webgl2&&!graphics.lost);
      assert.deepEqual(responseErrors,[]);
      (report.nativeSessions??=[]).push({name,frames,verified,charLists,graphics,entryURL:page.url(),browserPid:report.browsers.at(-1).pid,normalCache});
      const shot=join(out,`${name}-native-game.png`);await page.screenshot({path:shot});report.screenshots.push(shot);
      return {page,rect,close};
    } catch(error) {
      const failures=[error];try{await page.screenshot({path:join(out,`${name}-failure.png`)});}catch(capture){failures.push(capture);}
      try{await close();}catch(cleanup){failures.push(cleanup);}session=undefined;
      if(failures.length>1)throw new AggregateError(failures,failures.map(failure=>String(failure.stack??failure)).join('\n'));throw error;
    }
    };
    session={page,close,play};return play(name);
  };
  const close=async()=>{if(session){const current=session;session=undefined;await current.close();}};
  const current=await open('before');
  return {
    close,
    get page(){assert(session,'No active native browser session');return session.page;},
    async reopenSameBrowser(url){
      if(url!==undefined)entryURL=url;
      assert(normalCache&&session,'Same-browser verification requires the declared normal-cache session');
      const name=`same-cache-${sequence++}`;await session.play(name);const actual=await account(name);
      check(`${name}: same browser retains exact character progress`,JSON.stringify(actual)===JSON.stringify(expected));
    },
    async mutate() {
      const before=await account('before');check('fixture starts with an equipped weapon',before[0]===2711);
      const {page,rect}=current;
      // Dropping the synthetic starter weapon exercises an ordinary native inventory transaction, not a test control route.
      await page.mouse.move(rect.x+640,rect.y+385);await page.mouse.down();
      try{await page.mouse.move(rect.x+430,rect.y+380,{steps:12});}finally{await page.mouse.up();}
      const deadline=Date.now()+10000;let after;
      do{after=await account('after');if(after[0]===-1)break;await delay(200);}while(Date.now()<deadline);
      expected=[...before];expected[0]=-1;
      check('native inventory drop committed through normal account API',JSON.stringify(after)===JSON.stringify(expected));
      const shot=join(out,'inventory-dropped.png');await page.screenshot({path:shot});report.screenshots.push(shot);
    },
    async verify(keepConnected = false,url) {
      if(url!==undefined)entryURL=url;
      const name=`reopened-${sequence}`;
      await open(name);
      try{const actual=await account(name);check(`${name}: same synthetic character retains exact changed inventory`,JSON.stringify(actual)===JSON.stringify(expected));}
      finally{if(!keepConnected)await close();}
    },
  };
}
