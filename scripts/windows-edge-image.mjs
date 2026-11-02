import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {isAbsolute,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {windowsPowerShellExecutable} from './native-boundaries.mjs';

export async function installedEdgeImage() {
  const metadata=`$ErrorActionPreference='Stop'; Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; $path=(Get-Item -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe').GetValue(''); $file=Get-Item -LiteralPath $path; $signature=Get-AuthenticodeSignature -LiteralPath $path; [pscustomobject]@{executable=$path;product=$file.VersionInfo.ProductName;company=$file.VersionInfo.CompanyName;fileVersion=$file.VersionInfo.FileVersion;signature=$signature.Status.ToString();signer=$signature.SignerCertificate.Subject} | ConvertTo-Json -Compress`;
  const edge=JSON.parse(execFileSync(windowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-Command',metadata],{encoding:'utf8',timeout:30000}));
  assert(isAbsolute(edge.executable)&&basename(edge.executable).toLowerCase()==='msedge.exe');assert.equal(edge.product,'Microsoft Edge');assert.equal(edge.signature,'Valid','Installed Edge signature must validate');
  edge.sha256=createHash('sha256').update(await readFile(edge.executable)).digest('hex');return edge;
}
