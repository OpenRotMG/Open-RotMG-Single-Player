import assert from 'node:assert/strict';

export function verifySafariProcess(owned,current) {
  // A proved child can be reparented during shutdown without changing its birth identity.
  for(const key of ['pid','started','argv'])assert.equal(current[key],owned[key],`Safari driver process ${key} changed; ownership is not verified`);
}
export function verifySafariListener(root,currentRoot,lineage) {
  verifySafariProcess(root,currentRoot);
  assert.equal(currentRoot.ppid,root.ppid,'Spawned Safari wrapper parent changed');
  assert(lineage.length,'Actual listener lineage is required');
  assert.equal(new Set(lineage.map(entry=>entry.pid)).size,lineage.length,'Safari listener lineage must not cycle');
  for(const [index,entry] of lineage.entries()) {
    assert(Number.isSafeInteger(entry.pid)&&entry.pid>0&&Number.isSafeInteger(entry.ppid)&&entry.ppid>=0&&entry.started&&entry.argv,'Complete observed process identity required');
    if(index+1<lineage.length)assert.equal(entry.ppid,lineage[index+1].pid,'Safari listener ancestry is disconnected');
  }
  verifySafariProcess(root,lineage.at(-1));
}
export async function cleanupSafariDrivers(report,owned,operations) {
  report.driverCleanup=[];
  for(const target of owned)try{
    if(!operations.alive(target.pid))continue;
    const current=await operations.identity(target.pid);verifySafariProcess(target,current);
    operations.signal(target.pid,'SIGTERM');report.driverCleanup.push({...current,signal:'SIGTERM'});
    await operations.waitForExit(target.pid);
    if(operations.alive(target.pid))throw Error(`Owned driver process ${target.pid} did not exit`);
  }catch(error){report.errors.push(`Driver ownership/cleanup: ${error}; no successful cleanup claim`);report.status='error';}
}
