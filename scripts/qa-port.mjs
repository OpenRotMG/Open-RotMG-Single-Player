import { spawn, execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';

export function listenOnLoopback(server, port) {
  return new Promise((ok, bad) => {
    server.once('error', error => bad(new Error(`QA loopback port ${port} unavailable: ${error.message}. No existing owner was interrupted.`, {cause:error})));
    server.listen(port,'127.0.0.1',ok);
  });
}
export async function acquireQaPortLease() {
  if(process.platform!=='linux') {
    if(process.env.GITHUB_ACTIONS!=='true')throw Error('Native non-Linux QA requires an exclusively owned GitHub Actions job');
    return {kind:'dedicated GitHub Actions runner',release:async()=>{}};
  }
  const common=resolve(execFileSync('git',['rev-parse','--git-common-dir'],{encoding:'utf8'}).trim());
  // OS flock shares ownership across this repository's worktrees and releases on pipe EOF/process exit.
  const child=spawn('flock',['-n','-E','75',join(common,'desktop-qa-47831.lock'),process.execPath,'-e','process.stdout.write("locked\\n");process.stdin.resume();'],{stdio:['pipe','pipe','pipe']});
  let stderr='';child.stderr.on('data',bytes=>stderr+=bytes);
  const exited=new Promise(ok=>child.once('exit',(code,signal)=>ok({code,signal})));
  await new Promise((ok,bad)=>{
    child.once('error',bad);
    child.stdout.once('data',()=>ok());
    void exited.then(({code,signal})=>bad(Error(`Exclusive desktop QA port lease unavailable (exit=${code}, signal=${signal}): ${stderr}. No owner was interrupted.`)));
  });
  return {kind:'nonblocking OS flock',release:async()=>{
    child.stdin.end();const {code,signal}=await exited;
    if(code!==0)throw Error(`Desktop QA lease release failed: exit=${code}, signal=${signal}: ${stderr}`);
  }};
}
