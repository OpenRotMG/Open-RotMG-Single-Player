import assert from 'node:assert/strict';

export function ownedEdgeMode(args) {
  assert(args.length===0||(args.length===1&&args[0]==='--owned-edge-image'),'Select only explicit --owned-edge-image or the existing Chromium diagnostic');return args.length===1;
}
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
export function requireOwnedEdgeIdentity(source,copy) {
  requireMicrosoftEdgePublisher(source);requireMicrosoftEdgePublisher(copy);
  assert.notEqual(copy.executable.toLowerCase(),source.executable.toLowerCase(),'Never apply owned-image policy to installed Edge');
  for(const field of ['product','company','fileVersion','signature','signer','sha256']){assert(typeof source[field]==='string'&&source[field].length>0,`Installed Edge ${field} evidence required`);assert.equal(copy[field],source[field],`Owned Edge ${field} must match signed installed source`);}
  assert.equal(copy.signature,'Valid','Owned Edge signature must validate');
}
