import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';

export const inventoryPurpose='READ-ONLY default-resolution/profile FEASIBILITY INVENTORY; NOT OS invocation, game, graphics, offline, tool-free or cold/warm browser acceptance';
export function inventoryMode(args,platform,github) {
  assert(github==='true'&&['win32','linux'].includes(platform),'Inventory requires standard native Windows/Linux GitHub Actions');
  assert(args.length===0||(platform==='linux'&&args.length===1&&args[0]==='--private-query'),'No caller-selected target/profile/environment');
  return args.length===1;
}
export function failureDetails(error) {
  // execFile errors embed command arguments; only retain native diagnostics, never a process argv.
  return {name:error.name,code:error.code??null,status:error.status??null,signal:error.signal??null,message:error.stderr?String(error.stderr):error.message,...(error.stdout!==undefined||error.partialOutput!==undefined?{partialOutput:String(error.stdout??error.partialOutput)}:{})};
}
export function nativeInventoryJSON(run) {
  let output;try{output=run();const value=JSON.parse(output);assert(value&&typeof value==='object'&&!Array.isArray(value)&&Array.isArray(value.errors)&&Array.isArray(value.notReady),'Native inventory envelope is incomplete');return value;}catch(error){if(output!==undefined)error.partialOutput=output;throw error;}
}
export function requireRootImage(info) {
  assert(info.isFile()&&(info.mode&0o111)&&info.uid===0&&!(info.mode&0o022),'Executable must be root-owned, executable and not group/world-writable');
}
export async function observe(report,key,action) {
  try { const result=await action();report[key]=result;return result; }
  catch(error){report.errors.push({stage:key,...failureDetails(error)});return undefined;}
}
export async function persistInventory(path,report,write=writeFile,stderr=text=>process.stderr.write(text)) {
  try {await write(path,JSON.stringify(report,null,2)+'\n');}
  catch(error){report.status='failed';report.errors.push({stage:'receipt',...failureDetails(error)});stderr(`Default-browser inventory NOT PERSISTED; partial evidence:\n${JSON.stringify(report,null,2)}\n`);throw error;}
}
export function completeInventory(report) {
  report.status=report.errors.length?'failed':report.notReady.length?'not-ready':'feasibility-observed';
  report.acceptance=false;report.readiness=report.status==='feasibility-observed'?'PRECONDITIONS_ONLY; runtime/debugging unmeasured':'not-ready';
  return report.status==='failed'?1:report.status==='not-ready'?2:0;
}
export function profileOverride(words) {
  const values=[];
  for(let i=0;i<words.length;i++){
    if(words[i]==='--user-data-dir'){assert(words[i+1]&&!words[i+1].startsWith('--'),'Missing profile override value');values.push(words[++i]);}
    else if(words[i].startsWith('--user-data-dir='))values.push(words[i].slice('--user-data-dir='.length));
    else if(words[i]==='-profile'||words[i]==='--profile'){assert(words[i+1]&&!words[i+1].startsWith('-'),'Missing profile override value');values.push(words[++i]);}
  }
  assert(values.length<=1&&values.every(value=>value&&!value.includes('\0')&&((value.startsWith('/')&&!value.startsWith('//'))||/^[A-Za-z]:\\/.test(value))),'Ambiguous/empty/nonlocal profile override');return values[0]??null;
}
export function processEvidence({pid,birth,image,words}) {
  assert(Number.isSafeInteger(pid)&&pid>0&&birth&&typeof birth.bootId==='string'&&birth.bootId.length>0&&/^\d+$/.test(birth.startTicks)&&image,'Incomplete process identity');
  return {pid,birth,image,profileOverride:profileOverride(words)};
}
export function desktopEntry(text) {
  let active=false;const values={};
  for(const raw of text.split(/\r?\n/)){
    if(raw.startsWith('[')){active=raw==='[Desktop Entry]';continue;}
    if(!active||/^\s*(?:#|$)/.test(raw))continue;
    const match=/^([A-Za-z]+)=(.*)$/.exec(raw);
    if(match&&['Type','Exec','TryExec','Hidden','DBusActivatable'].includes(match[1])){assert(!(match[1] in values),'Duplicate desktop entry key');values[match[1]]=match[2];}
  }
  assert(values.Type==='Application'&&values.Exec&&values.Hidden!=='true','Missing/hidden/non-application desktop entry');
  return values;
}
export function desktopWords(exec) {
  const words=[];let word='',quoted=false,started=false;
  for(let i=0;i<exec.length;i++){
    const c=exec[i];
    if(c==='"'){quoted=!quoted;started=true;}
    else if(c==='\\'){assert(i+1<exec.length,'Truncated desktop escape');const next=exec[++i];assert('"\\`$'.includes(next),'Unsupported desktop escape');word+=next;started=true;}
    else if(/\s/.test(c)&&!quoted){if(started){words.push(word);word='';started=false;}}
    else {assert(!/[\u0000-\u001f'|;&<>`$]/.test(c),'Unsupported desktop Exec syntax');word+=c;started=true;}
  }
  assert(!quoted,'Unclosed desktop Exec quote');if(started)words.push(word);
  assert(words.length>0&&!words[0].includes('%')&&words[0]!=='env','Ambiguous desktop executable');
  for(const word of words.slice(1))assert(!/%/.test(word)||/^%[uUfFiick]$/.test(word),'Unsupported embedded desktop field code');
  return words;
}
export function localMount(path,mountinfo) {
  assert(path.startsWith('/')&&!path.includes('\0'),'Absolute local path required');
  const mounts=mountinfo.trim().split('\n').map(line=>{const [left,right]=line.split(' - ');assert(right,'Invalid mount inventory');return {path:left.split(' ')[4].replace(/\\([0-7]{3})/g,(_,oct)=>String.fromCharCode(parseInt(oct,8))),type:right.split(' ')[0]};});
  const match=mounts.filter(m=>path===m.path||path.startsWith(m.path==='/'?'/':m.path+'/')).sort((a,b)=>b.path.length-a.path.length)[0];
  assert(match&&['ext4','ext3','ext2','xfs','btrfs','overlay','tmpfs','squashfs'].includes(match.type),'Nonlocal/unsupported filesystem; no path access attempted');return match;
}
export function packageOwner(output,path) {
  const lines=output.trim().split('\n');assert(lines.length===1,'Ambiguous package owner');const suffix=': '+path;
  assert(lines[0].endsWith(suffix),'Package ownership differs from resolved path');const owner=lines[0].slice(0,-suffix.length);assert(/^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?$/.test(owner),'Unknown package ownership');return owner;
}
