import {writeFile} from 'node:fs/promises';

export async function closePrePidOfflineContext(context,report) {
  report.browserExitVerification='unverified';report.prePidFrameworkClose={attempted:true};report.status='failed';
  try{await context.close();report.prePidFrameworkClose.completed=true;}
  catch(error){report.errors.push(`Fresh pre-PID framework cleanup: ${error}`);report.prePidFrameworkClose.completed=false;}
}
export async function persistMacOfflineEvidence(report,path,write=writeFile,emit=console.error) {
  if(report.errors.length)report.status='failed';
  emit(JSON.stringify(report,null,2));
  try{await write(path,JSON.stringify(report,null,2));return true;}
  catch(error){report.status='failed';report.errors.push(`Receipt persistence ${path}: ${error}`);emit(JSON.stringify(report,null,2));return false;}
}
