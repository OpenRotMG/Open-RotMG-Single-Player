import assert from 'node:assert/strict';
import {connect} from 'node:net';
import {createServer} from 'node:http';
import {networkInterfaces} from 'node:os';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {ownNonLoopbackIPv4,requireGrammarDenials} from './macos-sbpl-grammar-case.mjs';
import {macOfflineErrorDetails} from './macos-offline-error.mjs';

assert(process.platform==='darwin'&&process.arch==='arm64'&&process.env.GITHUB_ACTIONS==='true','Grammar canary requires an owned native ARM Mac CI guest');
const report={purpose:'Single named SBPL grammar/local-address-scope diagnostic ONLY',status:'running',pid:process.pid,executable:process.execPath,externalTcp:[],ownAddressTcp:[],errors:[]};
const server=createServer((_request,response)=>response.end('loopback-ok'));
try{
  report.policyPath=process.argv[2];report.policySha256=createHash('sha256').update(await readFile(report.policyPath)).digest('hex');
  for(const host of ['1.1.1.1','8.8.8.8'])report.externalTcp.push(await tcpResult(host,80));
  requireGrammarDenials(report.externalTcp,'Public external TCP');
  await new Promise((ok,bad)=>{server.once('error',bad);server.listen(0,'127.0.0.1',ok);});
  const port=server.address().port;report.loopbackOrigin=`http://127.0.0.1:${port}`;
  assert.equal(await (await fetch(report.loopbackOrigin,{signal:AbortSignal.timeout(3000)})).text(),'loopback-ok');report.loopback=true;
  report.ownNonLoopbackIPv4=ownNonLoopbackIPv4(networkInterfaces());
  // Reuse the loopback-only listener's port: no non-loopback listener or neighbor traffic is created.
  for(const host of report.ownNonLoopbackIPv4)report.ownAddressTcp.push(await tcpResult(host,port));
  requireGrammarDenials(report.ownAddressTcp,'Guest own non-loopback IPv4');report.status='passed';
}catch(error){report.status='failed';report.failure=macOfflineErrorDetails(error);report.errors.push(String(error.stack??error));process.exitCode=1;}
finally{
  try{if(server.listening){server.closeAllConnections();await new Promise((ok,bad)=>server.close(error=>error?bad(error):ok()));}}catch(error){report.errors.push(`Loopback cleanup: ${error}`);report.status='failed';process.exitCode=1;}
  console.error(JSON.stringify(report));console.log(JSON.stringify(report));
}
function tcpResult(host,port){return new Promise(ok=>{
  const socket=connect({host,port});socket.setTimeout(3000,()=>{socket.destroy();ok({host,port,timeout:true});});
  socket.once('connect',()=>{socket.destroy();ok({host,port,connected:true});});socket.once('error',error=>ok({host,port,error:error.code,detail:macOfflineErrorDetails(error)}));
});}
