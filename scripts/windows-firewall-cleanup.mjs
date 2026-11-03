import assert from 'node:assert/strict';

export function windowsOfflineCanaryResult(error,stdout,stderr) {
  return {exitCode:error?error.code??null:0,signal:error?.signal??null,error:error?String(error):null,stdout,stderr};
}
export function verifyWindowsOfflineCanary(result,executable) {
  assert.equal(result.error,null,'Copied Node canary execution failed');assert.equal(result.exitCode,0);
  const proof=JSON.parse(result.stdout);assert.equal(proof.status,'passed');assert.equal(proof.executable,executable);return proof;
}
export async function cleanupWindowsOwnedRules(report,plans,operations) {
  report.retainedRules=[];report.programExitObservations=[];const removable=[];
  for(const plan of plans)try{
    const processes=await operations.processes(plan.program);assert(Array.isArray(processes),'Exact owned-image process inspection required');report.programExitObservations.push({...plan,processes});
    if(processes.length)report.retainedRules.push({...plan,processes,reason:'containment retained until disposable VM teardown'});else removable.push(plan.name);
  }catch(error){report.retainedRules.push({...plan,inspectionError:String(error.stack??error),reason:'exit UNVERIFIED; containment retained until disposable VM teardown'});}
  for(const rule of report.retainedRules)report.errors.push(`Containment retained for exact owned rule ${rule.name}: ${JSON.stringify(rule)}`);
  report.cleanupPending=report.retainedRules.length>0;
  await cleanupWindowsFirewallRules(report,removable,operations);
  try{report.rulesAfterCleanup=await operations.observe(plans.map(plan=>plan.name));if(report.rulesAfterCleanup.length)report.cleanupPending=true;assert(report.rulesAfterCleanup.every(rule=>report.retainedRules.some(retained=>retained.name===rule.name)),'Nonretained exact rules must be absent');for(const retained of report.retainedRules)assert(report.rulesAfterCleanup.some(rule=>rule.name===retained.name),`Retained containment rule absent: ${retained.name}`);}catch(error){report.cleanupPending=true;report.errors.push(`All owned rule final observation: ${error}`);}
  if(report.errors.length)report.status='failed';
}
export async function cleanupWindowsFirewallRules(report,names,operations) {
  try{report.rulesBeforeCleanup=await operations.observe(names);}catch(error){report.errors.push(`Pre-cleanup rule observation: ${error}`);}
  report.ruleRemovalOutcomes=[];
  for(const name of names)try{
    const result=await operations.remove(name);report.ruleRemovalOutcomes.push(result);assert.equal(result.name,name);
    const absent=result.category==='ObjectNotFound'&&result.errorId==='CmdletizationQuery_NotFound_InstanceID,Remove-NetFirewallRule';
    assert(result.removed===true||absent,`Owned rule removal failed: ${JSON.stringify(result)}`);
  }catch(error){report.errors.push(`Exact rule removal ${name}: ${error}`);}
  try{report.rulesAfterCleanup=await operations.observe(names);assert.equal(report.rulesAfterCleanup.length,0,'Exact owned rules must be removed');}catch(error){report.errors.push(`Final rule observation: ${error}`);}
  if(report.errors.length)report.status='failed';
}
