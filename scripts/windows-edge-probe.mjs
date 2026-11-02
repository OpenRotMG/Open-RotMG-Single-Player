import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {windowsProcessIdentity} from './native-boundaries.mjs';
import {installedEdgeImage} from './windows-edge-image.mjs';
import {closeWindowsEdge} from './windows-edge-cleanup.mjs';

assert(process.platform==='win32'&&process.arch==='x64'&&process.env.GITHUB_ACTIONS==='true','Edge capability probe requires an owned standard Windows x64 CI VM');
const out='.qa/windows-edge-probe',report={purpose:'Existing installed normal Microsoft Edge capability ONLY, NOT game/default-browser/offline acceptance',status:'initializing',errors:[]};
let context,protocol,identity;
try{
  await mkdir(out,{recursive:true});report.head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  report.edge=await installedEdgeImage();
  const tmp=await mkdtemp(join(process.env.RUNNER_TEMP,'edge-capability-')),profile=join(tmp,'fresh-profile');report.profile=profile;
  const args=['--remote-debugging-pipe',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--window-size=1000,800','about:blank'];report.command=[report.edge.executable,...args];
  context=await chromium.launchPersistentContext(profile,{executablePath:report.edge.executable,headless:false,chromiumSandbox:true,ignoreDefaultArgs:true,args,timeout:30000});
  const browser=context.browser();assert(browser);protocol=await browser.newBrowserCDPSession();
  const {processInfo}=await protocol.send('SystemInfo.getProcessInfo'),pid=processInfo.find(entry=>entry.type==='browser')?.id;report.observedPid=pid;assert(Number.isSafeInteger(pid)&&pid>0);
  identity=windowsProcessIdentity(pid);report.browser={...identity,version:browser.version(),systemInfo:await protocol.send('SystemInfo.getInfo')};
  assert(identity.executable.toLowerCase()===report.edge.executable.toLowerCase()&&identity.argv.includes(profile),'Created Edge must own the fresh profile');
  assert(!/--no-sandbox|--disable-setuid-sandbox|--disable-gpu-sandbox|--enable-unsafe-swiftshader|--disable-web-security|--use-angle|--ignore-gpu-blocklist/.test(identity.argv),'Normal sandbox and renderer required');
  const page=context.pages()[0];assert(page);await page.setContent('<title>Normal installed Edge capability</title><h1>WebGL2 capability - NOT game acceptance</h1><pre id="result"></pre><canvas width="256" height="256"></canvas>');
  report.webgl2=await page.evaluate(()=>{
    const gl=document.querySelector('canvas').getContext('webgl2'),result={supported:!!gl};
    if(gl){const debug=gl.getExtension('WEBGL_debug_renderer_info');Object.assign(result,{lost:gl.isContextLost(),version:gl.getParameter(gl.VERSION),vendor:gl.getParameter(gl.VENDOR),renderer:gl.getParameter(gl.RENDERER)});if(debug)result.unmaskedRenderer=gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);gl.clearColor(0.25,0.5,0.75,1);gl.clear(gl.COLOR_BUFFER_BIT);const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);result.pixel=Array.from(pixel);result.error=gl.getError();}
    document.querySelector('#result').textContent=JSON.stringify(result,null,2);return result;
  });
  await page.screenshot({path:join(out,'normal-edge-capability.png')});
  assert(report.webgl2.supported&&!report.webgl2.lost,'Normal installed Edge must provide nonlost WebGL2');assert.equal(report.webgl2.error,0);assert(report.webgl2.pixel.every((value,index)=>Math.abs(value-[64,128,191,255][index])<=1));report.status='passed';
}catch(error){report.status='failed';report.errors.push(String(error.stack??error));process.exitCode=1;await persist();}
finally{
  try{await closeWindowsEdge({context,protocol,identity,profile:report.profile,record:report});}catch(error){report.errors.push(`Observed Edge cleanup: ${error}`);}
  if(report.errors.length){report.status='failed';process.exitCode=1;}await persist();console.log(JSON.stringify({status:report.status,errors:report.errors},null,2));
}
async function persist(){try{await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));}catch(error){report.errors.push(`Report IO: ${error}`);report.status='failed';process.exitCode=1;console.error(JSON.stringify(report,null,2));}}
