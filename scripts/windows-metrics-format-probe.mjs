import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {installedEdgeImage} from './windows-edge-image.mjs';
import {requireMicrosoftEdgePublisher} from './windows-owned-edge.mjs';
import {captureEdgeMetrics,metricsHeaderLimit,metricsFormatPrimary,persistMetricsEvidence} from './windows-metrics-format.mjs';

const out='.qa/windows-edge-metrics-format',report={purpose:'READ-ONLY bounded installer-metrics header evidence; NOT data admission, mutation policy, browser, firewall or game acceptance',status:'initializing',head:process.env.GITHUB_SHA,headerLimit:metricsHeaderLimit,primary:metricsFormatPrimary,errors:[]};
await mkdir(out,{recursive:true});
try{
  assert(process.platform==='win32'&&process.arch==='x64'&&process.env.GITHUB_ACTIONS==='true','Requires owned native Windows x64 CI');assert.equal(process.argv.length,2,'No paths, flags or alternate sources accepted');
  report.sourceBefore=await installedEdgeImage();requireMicrosoftEdgePublisher(report.sourceBefore);report.sourceDirectory=dirname(report.sourceBefore.executable);
  report.before=[];await captureEdgeMetrics(report.sourceDirectory,report.before);
  report.after=[];await captureEdgeMetrics(report.sourceDirectory,report.after);
  report.sourceAfter=await installedEdgeImage();requireMicrosoftEdgePublisher(report.sourceAfter);
  assert.deepEqual(report.sourceAfter,report.sourceBefore,'Installed signed Edge image identity changed');assert.deepEqual(report.after,report.before,'Source PMA inventory/size/hash/header changed across capture');
  report.unknownHeaders=report.before.filter(file=>file.format.status==='UNKNOWN').length;report.status='captured';
}catch(error){report.status='failed';report.errors.push(String(error.stack??error));process.exitCode=1;}
finally{await persistMetricsEvidence(join(out,'result.json'),report);}
