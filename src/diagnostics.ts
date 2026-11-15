import {appendFileSync, existsSync, renameSync, statSync, readFileSync} from 'node:fs';
import {statfs, readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import os from 'node:os';

export type Problem = {title: string; said: string; next: string; step: string};
const HELP = 'Copy the report and post it in #help on Discord.';
const JOURNAL_LIMIT = 1024 * 1024;

/** A durable, crash-surviving record of what the launcher did, so reports show the steps before a failure. */
export class Journal {
  readonly path: string;
  constructor(storage: string) { this.path = join(storage, 'journal.jsonl'); }
  write(event: string, details: Record<string, unknown> = {}) {
    try { if (statSync(this.path).size > JOURNAL_LIMIT) renameSync(this.path, this.path.replace(/\.jsonl$/, '.1.jsonl')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    appendFileSync(this.path, JSON.stringify({at: new Date().toISOString(), event, ...details}) + '\n');
  }
  recent(count: number) {
    const lines: string[] = [];
    for (const path of [this.path.replace(/\.jsonl$/, '.1.jsonl'), this.path]) if (existsSync(path)) lines.push(...readFileSync(path, 'utf8').trim().split('\n'));
    return lines.slice(-count);
  }
}

/** Raised when the OS refuses to run a bundled program; carries what we could learn about why. */
export class LaunchError extends Error {
  constructor(readonly program: string, readonly cause: NodeJS.ErrnoException, readonly windows?: {code: number; message: string}, readonly file?: Record<string, unknown>) {
    super(`Could not run ${program}: ${cause.code ?? cause.message}${windows ? `; Windows ${windows.code}: ${windows.message}` : ''}`);
  }
}

export async function launchFailure(binary: string, cause: NodeJS.ErrnoException, expectedSha256?: string): Promise<LaunchError> {
  const file: Record<string, unknown> = {path: binary, exists: existsSync(binary)};
  if (file.exists) {
    const bytes = await readFile(binary);
    file.bytes = bytes.length;
    if (expectedSha256) file.matchesBuild = createHash('sha256').update(bytes).digest('hex') === expectedSha256;
    if (process.platform === 'win32') file.downloadedFromInternet = existsSync(binary + ':Zone.Identifier');
  }
  let windows: {code: number; message: string} | undefined;
  // Node reports most Windows launch refusals as UNKNOWN; .NET exposes the native error code and message.
  if (process.platform === 'win32' && file.exists) {
    const script = `try{$p=[Diagnostics.Process]::Start((New-Object Diagnostics.ProcessStartInfo -Property @{FileName='${binary.replaceAll("'", "''")}';Arguments='--probe-launch';UseShellExecute=$false;CreateNoWindow=$true}));try{$p.Kill()}catch{};'0|started'}catch{$e=$_.Exception;while($e.InnerException){$e=$e.InnerException};"$($e.NativeErrorCode)|$($e.Message)"}`;
    const {stdout} = await promisify(execFile)(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], {timeout: 20_000, windowsHide: true});
    const [code, ...message] = stdout.trim().split('|');
    windows = {code: Number(code), message: message.join('|').trim()};
  }
  return new LaunchError(binary.split(/[\\/]/).pop()!, cause, windows, file);
}

const windowsCauses: Record<number, string> = {
  4551: 'Smart App Control or an app-control policy blocks programs that are not signed. Turn it off in Windows Security → App & browser control, or wait for a signed release.',
  4556: 'Smart App Control or an app-control policy blocks programs that are not signed. Turn it off in Windows Security → App & browser control, or wait for a signed release.',
  225: 'Your antivirus blocked it. Allow openrotmg.exe in your antivirus, then click Play.',
  226: 'Your antivirus blocked it. Allow openrotmg.exe in your antivirus, then click Play.',
  1260: 'A Windows policy blocked it. Ask whoever manages this computer, or play on another one.',
  5: 'Windows or your antivirus refused access. Allow openrotmg.exe in your antivirus, or move the game folder out of Downloads, then click Play.',
  2: 'The file is missing, often removed by an antivirus. Restore it from quarantine or extract the ZIP again.',
};
const nodeCauses: Record<string, string> = {
  ENOSPC: 'Your disk is full. Free some space, then try again.',
  EACCES: 'The game could not use its folder. Move the whole game folder somewhere you own, outside OneDrive, then try again.',
  EPERM: 'The game could not use its folder. Move the whole game folder somewhere you own, outside OneDrive, then try again.',
  EBUSY: 'Another program is using the game files. Close it, then try again.',
  EADDRINUSE: 'Another program is using the game\'s network port. Close other copies of the game, then try again.',
};
const steps: Record<string, string> = {'runtime:start': 'Couldn\'t start the game', 'server:install': 'The server update didn\'t finish', 'launcher:install': 'The launcher update didn\'t finish', 'save:import': 'The import didn\'t finish', 'save:confirm-import': 'The import didn\'t finish', 'save:backup': 'The backup didn\'t finish', 'save:restore': 'The restore didn\'t finish', 'account:edit': 'The account change didn\'t finish', 'account:list': 'Couldn\'t load accounts'};

export function explain(error: unknown, step: string): Problem {
  const title = steps[step] ?? (step === 'playing' ? 'The game server stopped' : 'That didn\'t finish');
  if (error instanceof LaunchError) {
    const known = error.windows ? windowsCauses[error.windows.code] : nodeCauses[error.cause.code ?? ''];
    const said = error.windows && error.windows.code ? `Windows refused to run ${error.program}: "${error.windows.message}" (code ${error.windows.code})` : `The system refused to run ${error.program}: ${error.cause.code ?? error.cause.message}`;
    return {title, said, next: known ?? HELP, step};
  }
  const code = (error as NodeJS.ErrnoException)?.code, message = error instanceof Error ? error.message : String(error);
  return {title, said: message.split('\n')[0].slice(0, 300), next: (code && nodeCauses[code]) ?? (/port \d+ unavailable/i.test(message) ? nodeCauses.EADDRINUSE : HELP), step};
}

export async function identity(context: {launcher: string; server: string; serverRoot: string; folder: string; storage: string}) {
  const pins = JSON.parse(await readFile(join(context.serverRoot, 'build-identity.json'), 'utf8')).pins;
  const disk = await statfs(context.storage);
  const folder = context.folder.toLowerCase();
  return {
    launcher: context.launcher, server: context.server, serverCommit: pins.server.commitCount, clientCommit: pins.client.commitCount,
    os: `${os.type()} ${os.release()} ${os.version()} ${os.arch()}`, locale: Intl.DateTimeFormat().resolvedOptions().locale,
    folder: context.folder, inDownloads: folder.includes('downloads'), cloudSynced: /onedrive|dropbox|google ?drive|icloud/.test(folder), freeGB: Math.round(disk.bavail * disk.bsize / 1e9),
  };
}

export function redact(text: string) {
  return text.replaceAll(os.homedir(), '~').replace(/[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}/gi, '<email>');
}

export function report(identity: Record<string, unknown>, problem: Problem | undefined, journal: Journal, serverLines: string[]) {
  return redact([
    `OpenRotMG Singleplayer report · ${new Date().toISOString()}`,
    ...Object.entries(identity).map(([key, value]) => `${key}: ${value}`),
    '', problem ? `Problem: ${problem.title}\n  ${problem.said}\n  Next: ${problem.next}\n  Step: ${problem.step}` : 'Problem: none shown',
    '', 'Recent events:', ...journal.recent(60).map(line => '  ' + line),
    '', 'Server log:', ...serverLines.slice(-40).map(line => '  ' + line),
  ].join('\n'));
}
