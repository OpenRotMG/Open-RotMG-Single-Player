import assert from 'node:assert/strict';

export function windowsOfflineCanaryResult(error,stdout,stderr) {
  return {exitCode:error?error.code??null:0,signal:error?.signal??null,error:error?String(error):null,stdout,stderr};
}
export function verifyWindowsOfflineCanary(result,executable) {
  assert.equal(result.error,null,'Copied Node canary execution failed');assert.equal(result.exitCode,0);
  const proof=JSON.parse(result.stdout);assert.equal(proof.status,'passed');assert.equal(proof.executable,executable);return proof;
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
