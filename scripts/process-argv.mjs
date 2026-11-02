import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
export async function processArgv(pid) {
  if(process.platform==='linux')return await readFile(`/proc/${pid}/cmdline`,'utf8');
  if(process.platform==='darwin')return execFileSync('ps',['-ww','-p',String(pid),'-o','command='],{encoding:'utf8'});
  if(process.platform==='win32')return execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],{encoding:'utf8'});
  throw Error(`Unsupported native process-argv platform: ${process.platform}`);
}
