import assert from 'node:assert/strict';
import {connect} from 'node:net';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {macOfflineErrorDetails} from './macos-offline-error.mjs';

assert(process.platform==='darwin'&&process.arch==='arm64'&&process.env.GITHUB_ACTIONS==='true','Canary requires owned native macOS ARM64 CI');
const policyPath=process.argv[2],policy=await readFile(policyPath,'utf8');
const report={status:'running',pid:process.pid,executable:process.execPath,version:process.version,argv:process.argv,policyPath,policySha256:createHash('sha256').update(policy).digest('hex'),externalTcp:[],errors:[]};
const server=createServer((_request,response)=>response.end('loopback-ok'));
try{
  for(const host of ['1.1.1.1','8.8.8.8'])await new Promise((ok,bad)=>{
    const socket=connect({host,port:80});socket.setTimeout(3000,()=>{socket.destroy();bad(Error('Timeout is not OS denial proof'));});
    socket.once('connect',()=>{socket.destroy();bad(Error('External TCP unexpectedly connected'));});
    socket.once('error',error=>{report.externalTcp.push({host,port:80,error:error.code});try{assert(['EPERM','EACCES'].includes(error.code),'Actual OS permission denial required');ok();}catch(cause){bad(cause);}});
  });
  await new Promise((ok,bad)=>{server.once('error',bad);server.listen(0,'127.0.0.1',ok);});
  report.loopbackOrigin=`http://127.0.0.1:${server.address().port}`;
  assert.equal(await (await fetch(report.loopbackOrigin)).text(),'loopback-ok');report.loopback=true;report.status='passed';
}catch(error){report.status='failed';report.failure=macOfflineErrorDetails(error);report.errors.push(String(error.stack??error));process.exitCode=1;}
finally{
  try{if(server.listening){server.closeAllConnections();await new Promise((ok,bad)=>server.close(error=>error?bad(error):ok()));}}catch(error){report.errors.push(`HTTP cleanup: ${error}`);report.status='failed';process.exitCode=1;}
  console.error(JSON.stringify(report));console.log(JSON.stringify(report));
}
