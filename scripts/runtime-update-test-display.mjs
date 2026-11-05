import {spawn,execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';

export async function updateTestDisplay(out){
 const env={...process.env,XDG_CONFIG_HOME:join(out,'config'),XDG_CACHE_HOME:join(out,'cache'),XDG_DATA_HOME:join(out,'data')};delete env.WAYLAND_DISPLAY;delete env.NODE_OPTIONS;
 if(process.platform!=='linux'){assert.equal(env.GITHUB_ACTIONS,'true','Native non-Linux QA requires a dedicated owned GitHub runner');return{env,proof:{kind:'dedicated native GitHub runner'},close:async()=>{}};}
 assert(env.DBUS_SESSION_BUS_ADDRESS&&!env.DBUS_SESSION_BUS_ADDRESS.includes('/run/user/'),'Updater QA must run in a private dbus-run-session');
 const root=env.OPENROTMG_TEST_TMP_ROOT;assert(root&&isAbsolute(root),'Explicit short owned on-disk TMPDIR root required');await mkdir(root,{recursive:true});const tmp=await mkdtemp(join(root,'upd-'));assert(Buffer.byteLength(tmp)<65);Object.assign(env,{TMPDIR:tmp,TEMP:tmp,TMP:tmp});
 const auth=join(out,'Xauthority'),cookie=randomBytes(16).toString('hex');await writeFile(auth,'',{mode:0o600});execFileSync('xauth',['-f',auth,'add',':99','MIT-MAGIC-COOKIE-1',cookie]);
 const display=spawn('Xvfb',['-displayfd','3','-screen','0','1400x1100x24','-nolisten','tcp','-auth',auth],{stdio:['ignore','ignore','pipe','pipe']});let number='',error='';display.stdio[3].on('data',bytes=>number+=bytes);display.stderr.on('data',bytes=>error+=bytes);
 const deadline=Date.now()+10000;while(!number.includes('\n')&&Date.now()<deadline&&display.exitCode===null)await delay(50);assert(number.includes('\n'),`Owned private Xvfb did not initialize: ${error}`);
 env.DISPLAY=':'+number.trim();env.XAUTHORITY=auth;execFileSync('xauth',['-f',auth,'add',env.DISPLAY,'MIT-MAGIC-COOKIE-1',cookie]);
 return{env,proof:{kind:'private Xvfb/DBus',pid:display.pid,display:env.DISPLAY,xauthority:auth,bus:env.DBUS_SESSION_BUS_ADDRESS,tmp},close:async()=>{display.kill('SIGTERM');const deadline=Date.now()+10000;while(display.exitCode===null&&display.signalCode===null&&Date.now()<deadline)await delay(50);assert(display.exitCode!==null||display.signalCode!==null,'Owned Xvfb did not close');}};
}
