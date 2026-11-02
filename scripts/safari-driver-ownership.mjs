import assert from 'node:assert/strict';

export const SAFARI_SERVICE_REQUIREMENT='=anchor apple and identifier "com.apple.WebDriver.HTTPService"';
export function verifySafariProcess(owned,current) {
  for(const key of ['pid','started','argv'])assert.equal(current[key],owned[key],`Safari CLI process ${key} changed; ownership is not verified`);
}
export function verifySafariEndpoint(root,currentRoot,service,uid) {
  verifySafariProcess(root,currentRoot);
  assert.equal(currentRoot.ppid,root.ppid,'Spawned Safari CLI parent changed');assert.equal(root.uid,uid);
  assert.equal(service.uid,uid,'Safari XPC service must run as the current user');assert.equal(service.ppid,1,'Expected OS-managed launchd service');
  assert(/^\/System\/Volumes\/Preboot\/Cryptexes\/App\/System\/Library\/StagedFrameworks\/Safari\/WebDriver\.framework\/Versions\/[^/]+\/XPCServices\/com\.apple\.WebDriver\.HTTPService\.xpc\/Contents\/MacOS\/com\.apple\.WebDriver\.HTTPService$/.test(service.executable),'Unexpected installed Safari HTTPService executable');
  assert.equal(service.signature.requirement,SAFARI_SERVICE_REQUIREMENT);assert.equal(service.signature.status,0,'Apple signature/identifier verification failed');
}
export async function cleanupSafariCli(report,root,operations) {
  report.driverCleanup=[];
  if(!root)return;
  try{
    if(!operations.alive(root.pid))return;
    const current=await operations.identity(root.pid);verifySafariProcess(root,current);
    operations.signal(root.pid,'SIGTERM');report.driverCleanup.push({...current,signal:'SIGTERM'});
    await operations.waitForExit(root.pid);
    if(operations.alive(root.pid))throw Error(`Owned Safari CLI ${root.pid} did not exit`);
  }catch(error){report.errors.push(`CLI ownership/cleanup: ${error}; no successful cleanup claim`);report.status='error';}
}
