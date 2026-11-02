import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {installedEdgeImage} from './windows-edge-image.mjs';
import {windowsProcessIdentity} from './native-boundaries.mjs';
import {closeWindowsEdge} from './windows-edge-cleanup.mjs';

export function assertNativeEdgeEnvironment(platform,arch,github,extraArgs) {
  assert(platform==='win32'&&arch==='x64'&&github==='true','ci-edge requires an owned native Windows x64 GitHub Actions runner');
  assert(Array.isArray(extraArgs)&&extraArgs.length===0,'ci-edge does not permit extra browser flags');
}
export function nativeEdgeLaunchOptions(executable,profile,env) {
  assert(executable&&profile,'Explicit installed Edge image and fresh profile required');
  return {executablePath:executable,headless:false,chromiumSandbox:true,ignoreDefaultArgs:true,env,timeout:30000,args:['--remote-debugging-pipe',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--window-size=1280,960','about:blank']};
}
export async function openNativeEdge({owner,profile,env,report}) {
  assertNativeEdgeEnvironment(process.platform,process.arch,process.env.GITHUB_ACTIONS,JSON.parse(process.env.PI_NATIVE_TEST_CHROME_ARGS??'[]'));
  const record={owner,profile,mode:'ci-edge'};(report.browsers??=[]).push(record);
  let context,protocol,identity;
  const close=()=>closeWindowsEdge({context,protocol,identity,profile,record});
  try{
    record.edgeImage=await installedEdgeImage();
    context=await chromium.launchPersistentContext(profile,nativeEdgeLaunchOptions(record.edgeImage.executable,profile,env));
    const browser=context.browser();assert(browser);protocol=await browser.newBrowserCDPSession();
    const {processInfo}=await protocol.send('SystemInfo.getProcessInfo'),pid=processInfo.find(entry=>entry.type==='browser')?.id;record.observedPid=pid;assert(Number.isSafeInteger(pid)&&pid>0);
    identity=windowsProcessIdentity(pid);Object.assign(record,identity,{version:browser.version(),systemInfo:await protocol.send('SystemInfo.getInfo')});
    assert(identity.executable.toLowerCase()===record.edgeImage.executable.toLowerCase()&&identity.argv.includes(profile),'Created Edge must own the fresh profile');
    assert(!/--no-sandbox|--disable-setuid-sandbox|--disable-gpu-sandbox|--enable-unsafe-swiftshader|--disable-web-security|--use-angle|--ignore-gpu-blocklist/.test(identity.argv),'Normal Edge sandbox and renderer required');
    const page=context.pages()[0];assert(page,'Fresh Edge blank page missing');return {browser,context,page,close};
  }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],`${error.stack??error}\nEdge cleanup: ${cleanup.stack??cleanup}`);}throw error;}
}
