import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {decodeMetricsHeader,metricsHeaderLimit,metricsFormatPrimary} from './windows-metrics-format.mjs';

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
const installerMetricsSourceRefs=[
  'https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.75/chrome/installer/util/util_constants.h#448',
  'https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.75/chrome/browser/metrics/chrome_metrics_service_client.cc#354',
  'https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.75/components/metrics/file_metrics_provider.cc#457'
];
const installerMetricsPath=/^SetupMetrics\/[0-9]+_[0-9]+(?:_[0-9]+)?\.pma$/;
export function classifyOwnedEdgeInstallerMetrics({original,copyBeforeRun,sourceImage,metricsBeforeRun,metricsCopySizesBeforeRun}) {
  requireMicrosoftEdgePublisher(sourceImage);assert.equal(sourceImage.product,'Microsoft Edge');assert.equal(original.files['msedge.exe'],sourceImage.sha256,'Signed Microsoft Edge image must bind original inventory');assert.deepEqual(copyBeforeRun,original,'Complete before-run owned Edge inventory must match');
  assert(Array.isArray(metricsBeforeRun)&&metricsBeforeRun.length>0&&metricsBeforeRun.length<=64,'Live installer metrics evidence required before launch');assert(metricsCopySizesBeforeRun&&typeof metricsCopySizesBeforeRun==='object'&&!Array.isArray(metricsCopySizesBeforeRun),'Live copied metrics size evidence required');
  const expected=Object.keys(original.files).filter(path=>installerMetricsPath.test(path)).sort(),seen=new Set();
  const classified=metricsBeforeRun.map(file=>{
    const path=file.relativePath;assert(typeof path==='string'&&installerMetricsPath.test(path),`Installer metrics namespace required: ${path}`);assert(!seen.has(path),`Duplicate installer metrics evidence: ${path}`);seen.add(path);
    assert(/^[0-9a-f]{64}$/.test(file.sha256)&&Object.hasOwn(original.files,path)&&original.files[path]===file.sha256&&copyBeforeRun.files[path]===file.sha256,`Installer metrics full-file hash must bind original and copy: ${path}`);
    assert(Number.isSafeInteger(file.size)&&file.size>0&&Object.hasOwn(metricsCopySizesBeforeRun,path)&&metricsCopySizesBeforeRun[path]===file.size,`Installer metrics size must bind live source and copy: ${path}`);
    assert(typeof file.headerHex==='string'&&/^(?:[0-9a-f]{2})+$/.test(file.headerHex)&&file.headerHex.length===2*Math.min(metricsHeaderLimit,file.size),`Bounded installer metrics header required: ${path}`);
    const header=Buffer.from(file.headerHex,'hex'),format=decodeMetricsHeader(header);assert.equal(format.status,'UPSTREAM_V3_HEADER_OBSERVED',`UNKNOWN installer metrics header: ${path}`);assert.equal(format.allocatorName,'SetupMetrics',`Installer metrics allocator name must match: ${path}`);assert.deepEqual(file.format,format,`Installer metrics decoded evidence differs: ${path}`);
    if(file.size<=metricsHeaderLimit)assert.equal(createHash('sha256').update(header).digest('hex'),file.sha256,`Complete captured metrics bytes must match full-file hash: ${path}`);
    return {...file,classification:'installer-histogram header/namespace DATA classification, NOT full histogram payload validation',primary:metricsFormatPrimary,sourceRefs:installerMetricsSourceRefs};
  });
  assert.deepEqual([...seen].sort(),expected,'Missing live installer metrics evidence');assert.deepEqual(Object.keys(metricsCopySizesBeforeRun).sort(),expected,'Copy size evidence must cover exactly live installer metrics');return classified;
}
export function ownedEdgeImageDifference(original,copy) {
  return {added:Object.keys(copy.files).filter(path=>!Object.hasOwn(original.files,path)).map(path=>({path,afterSha256:copy.files[path]})),modified:Object.keys(copy.files).filter(path=>Object.hasOwn(original.files,path)&&copy.files[path]!==original.files[path]).map(path=>({path,beforeSha256:original.files[path],afterSha256:copy.files[path]})),deleted:Object.keys(original.files).filter(path=>!Object.hasOwn(copy.files,path)).map(path=>({path,beforeSha256:original.files[path]}))};
}
export function requireOwnedEdgeAfterRun(image) {
  const {original,sourceAfterRun:source,copyAfterRun:copy}=image;assert.deepEqual(source,original,'Installed Edge source image changed');
  const classified=new Map(classifyOwnedEdgeInstallerMetrics(image).map(file=>[file.relativePath,file])),diff=ownedEdgeImageDifference(original,copy);
  assert.equal(diff.added.length,0,'Owned Edge additions are forbidden');assert.equal(diff.modified.length,0,'Owned Edge modifications are forbidden');
  const consumedInstallerMetrics=diff.deleted.map(entry=>{const beforeClassification=classified.get(entry.path);assert(beforeClassification&&beforeClassification.sha256===entry.beforeSha256,`Unclassified owned Edge deletion: ${JSON.stringify(entry)}`);return {...entry,beforeClassification};});
  if(diff.deleted.length===0)requireOwnedEdgeInventory(original,source,copy);
  return {consumedInstallerMetrics};
}
export function requireOwnedEdgeIdentity(source,copy) {
  requireMicrosoftEdgePublisher(source);requireMicrosoftEdgePublisher(copy);
  assert.notEqual(copy.executable.toLowerCase(),source.executable.toLowerCase(),'Never apply owned-image policy to installed Edge');
  for(const field of ['product','company','fileVersion','signature','signer','sha256']){assert(typeof source[field]==='string'&&source[field].length>0,`Installed Edge ${field} evidence required`);assert.equal(copy[field],source[field],`Owned Edge ${field} must match signed installed source`);}
  assert.equal(copy.signature,'Valid','Owned Edge signature must validate');
}
