import assert from 'node:assert/strict';

export function ownedEdgeMode(args) {
  assert(args.length===0||(args.length===1&&args[0]==='--owned-edge-image'),'Select only explicit --owned-edge-image or the existing Chromium diagnostic');return args.length===1;
}
export function openOwnedEdgePage(context) { return context.newPage(); }
export function requireMicrosoftEdgePublisher(image) {
  assert.equal(image.signature,'Valid','Microsoft Edge Authenticode must validate');assert.equal(image.company,'Microsoft Corporation','Microsoft Edge company must match');
  assert.equal(image.signer,'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US','Microsoft Edge signer identity must match the validated publisher');
}
export function requireOwnedEdgeRulePrograms(programs,node,source,copy) {
  requireOwnedEdgeIdentity(source,copy);assert.deepEqual(programs,[node,copy.executable],'Firewall programs must be only the owned Node and copied Edge paths');
}
export function requireOwnedEdgeInventory(original,source,copy) {
  assert.deepEqual(source,original,'Installed Edge source image changed');
  assert.deepEqual(copy,original,'Complete owned Edge image relative-path/hash inventory differs');
}
const consumedInstallerMetrics={path:'SetupMetrics/3960_13436344830356102_3960.pma',beforeSha256:'c9bf34f471c0ac43e064875bd9a6f27bbf6a9fe876dce7ab84ce7643d2661def',sourceRefs:[
  'https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.75/chrome/installer/util/util_constants.h#448',
  'https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.75/chrome/browser/metrics/chrome_metrics_service_client.cc#354',
  'https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.75/components/metrics/file_metrics_provider.cc#457'
]};
export function ownedEdgeImageDifference(original,copy) {
  return {added:Object.keys(copy.files).filter(path=>!Object.hasOwn(original.files,path)).map(path=>({path,afterSha256:copy.files[path]})),modified:Object.keys(copy.files).filter(path=>Object.hasOwn(original.files,path)&&copy.files[path]!==original.files[path]).map(path=>({path,beforeSha256:original.files[path],afterSha256:copy.files[path]})),deleted:Object.keys(original.files).filter(path=>!Object.hasOwn(copy.files,path)).map(path=>({path,beforeSha256:original.files[path]}))};
}
export function requireOwnedEdgeAfterRun(original,source,copy) {
  assert.deepEqual(source,original,'Installed Edge source image changed');const diff=ownedEdgeImageDifference(original,copy);
  assert.equal(diff.added.length,0,'Owned Edge additions are forbidden');assert.equal(diff.modified.length,0,'Owned Edge modifications are forbidden');
  for(const entry of diff.deleted)assert(entry.path===consumedInstallerMetrics.path&&entry.beforeSha256===consumedInstallerMetrics.beforeSha256,`Unexplained owned Edge deletion: ${JSON.stringify(entry)}`);
  if(diff.deleted.length===0)requireOwnedEdgeInventory(original,source,copy);
  return {consumedInstallerMetrics:diff.deleted.map(entry=>({...entry,classification:'consumed installer histogram data, not runtime code/resources',sourceRefs:consumedInstallerMetrics.sourceRefs}))};
}
export function requireOwnedEdgeIdentity(source,copy) {
  requireMicrosoftEdgePublisher(source);requireMicrosoftEdgePublisher(copy);
  assert.notEqual(copy.executable.toLowerCase(),source.executable.toLowerCase(),'Never apply owned-image policy to installed Edge');
  for(const field of ['product','company','fileVersion','signature','signer','sha256']){assert(typeof source[field]==='string'&&source[field].length>0,`Installed Edge ${field} evidence required`);assert.equal(copy[field],source[field],`Owned Edge ${field} must match signed installed source`);}
  assert.equal(copy.signature,'Valid','Owned Edge signature must validate');
}
