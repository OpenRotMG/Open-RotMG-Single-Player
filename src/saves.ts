import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, copyFile, rm, stat, readdir, lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Runtime, serverCommandPath } from './runtime';

import {UserMessage} from './user-message';
import {launchFailure} from './diagnostics';

export type ImportPreview = { account: number; login: string; replaced: boolean; disclosure: string; exported_at: number; name: string; character_count: number; expected: string };
export type SnapshotPreview = { verified: true; schema: number; scope: 'all-local-accounts'; account_count: number; character_count: number };
export type SaveResult = { message: string; path?: string; login?: string };
export type LocalAccount = {account:number;name:string;username:string|null;expected:string};
export type BackupFile = { name: string; modified: number; bytes: number };
export const isBackupName = (name: unknown): name is string => typeof name === 'string' && name.length <= 255 && /\.(sqlite|db)$/.test(name) && !/[<>:"|?*]/.test(name) && !/\p{Cc}/u.test(name) && !name.includes('/') && !name.includes('\\');
export type SaveDialogs = {
  choose(): Promise<string | undefined>;
  confirmRestore(preview: SnapshotPreview, modified: string): Promise<boolean>;
  openFolder(path: string): Promise<string>;
};
const MAX_ACCOUNT_BYTES = 32 * 1024 * 1024, MAX_OUTPUT_BYTES = 64 * 1024;
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const validLogin=(value:unknown):value is string=>typeof value==='string'&&value.length<=254&&/^[^\s@]+@[^\s@]+$/.test(value)&&!/[\p{Cc}]/u.test(value);
export function checkedPassword(value: unknown, confirmation: unknown): string {
  if (typeof value !== 'string' || typeof confirmation !== 'string' || value !== confirmation || Buffer.from(value, 'utf8').toString('utf8') !== value || Buffer.byteLength(value) < 5 || Buffer.byteLength(value) > 128 || /\p{Cc}/u.test(value)) throw new UserMessage(value!==confirmation?'The passwords do not match.':'Use 5 to 128 characters without line breaks.');
  return value;
}

export class AuthorityUnchangedError extends Error { constructor(message:string,options?:ErrorOptions) { super(message,options);this.name='AuthorityUnchangedError'; } }

/** Only server-owned named save commands are reachable here; paths never come from IPC. */
export type SaveAuthorityRuntime = Pick<Runtime,'runtimePaths'|'resources'|'blockAmbiguousSave'>;
// The server is bundled with this exact launcher build, so its JSON shapes match these types.
export async function saveAuthority<T>(runtime: SaveAuthorityRuntime, command: 'preview' | 'import' | 'replace' | 'snapshot' | 'verify-snapshot' | 'restore' | 'accounts' | 'account-edit', paths: string[], password?: string): Promise<T> {
  const { binary } = runtime.runtimePaths();
  let output = Buffer.alloc(0), stderrBytes = 0, overflow = false, spawnError: Error | undefined, pipeError: Error | undefined;
  const child = spawn(serverCommandPath(binary), ['--local-save', command, ...paths], { cwd: runtime.resources, windowsHide: true, env: authorityEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  const collect = (current: Buffer, bytes: Buffer) => {
    if (current.length + bytes.length > MAX_OUTPUT_BYTES) overflow = true;
    return Buffer.concat([current, bytes.subarray(0, Math.max(0, MAX_OUTPUT_BYTES - current.length))]);
  };
  child.stdout.on('data', bytes => { output = collect(output, bytes); });
  child.stderr.on('data', bytes => { stderrBytes += bytes.length; if (stderrBytes > MAX_OUTPUT_BYTES) overflow = true; });
  child.once('error', error => { spawnError = error; });
  child.stdin.on('error', error => { pipeError = error; });
  const closed = new Promise<{code: number | null; signal: string | null}>(resolve => child.once('close', (code, signal) => resolve({code, signal})));
  const secret = password === undefined ? undefined : Buffer.from(password, 'utf8');
  child.stdin.end(secret, () => secret?.fill(0));
  password = undefined;
  const { code, signal } = await closed;
  const unverified = (detail: string) => {
    const error = new Error(`Save authority ${command} completion is unverified at ${binary}: ${detail}. No success or unchanged destination is claimed; retain state and backups before recovery. Replay is blocked.`);
    runtime.blockAmbiguousSave(error);
    return error;
  };
  // A program that never started cannot have changed the save, so this is reported without blocking saves.
  if (spawnError && child.pid === undefined) throw await launchFailure(binary, spawnError);
  if (spawnError) throw unverified(`could not start: ${spawnError.message}`);
  if (signal || overflow || (pipeError && (code === 0 || (pipeError as NodeJS.ErrnoException).code !== 'EPIPE'))) throw unverified(`exit=${code}, signal=${signal}, outputLimit=${overflow}, stdin=${pipeError?.message ?? 'closed'}`);
  if (code === null) throw unverified('child closed without an exit status');
  let result: T;
  try { result = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(output)); }
  catch { throw unverified(`exit=${code}; invalid outcome JSON`); }
  if (code !== 0) {
    const failure = result as {protocol: number; operation: string; outcome: string; error: string};
    if (!failure || Object.keys(failure).length !== 4 || failure.protocol !== 1 || failure.operation !== command || !['unchanged', 'unknown'].includes(failure.outcome) || typeof failure.error !== 'string' || !failure.error.trim() || Buffer.byteLength(failure.error) > MAX_OUTPUT_BYTES) throw unverified(`exit=${code}; invalid failure envelope (protocol/operation/outcome/error)`);
    if (failure.outcome === 'unknown') throw unverified(`exit=${code}; ${failure.error}`);
    throw new AuthorityUnchangedError(`Save authority ${command} failed (exit ${code}) at ${binary}: ${failure.error}. Destination game save unchanged; output/backup files may exist. No output success is claimed.`);
  }
  return result;
}
function authorityEnvironment() {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG']) if (process.env[key]) env[key] = process.env[key];
  return env;
}

type Confirmation = { expected: string; password: string; replace: boolean };
type PendingImport = { preview: ImportPreview; accept(value: Confirmation | undefined): void; outcome: Promise<SaveResult | undefined> };
export class SaveControls {
  readonly backups: string;
  private pending?: PendingImport;
  constructor(private runtime: Runtime, private dialogs: SaveDialogs) { this.backups = join(runtime.userData, 'backups'); }
  // SQLite adds journal and native staging suffixes, so keep names compact inside the portable folder.
  private backupPath(reason: string) { return join(this.backups, `${Date.now()}-${reason}-${randomUUID()}.sqlite`); }
  private async backupDirectory() { await mkdir(this.backups, { recursive: true, mode: 0o700 }); }
  /** The server reads a private copy, so a file changing on disk cannot differ between preview and import. */
  private async staged<T>(source: string, action: (path: string) => Promise<T>): Promise<T> {
    const parent = join(this.runtime.storage, 'save-staging');
    await mkdir(parent, {recursive: true, mode: 0o700});
    const directory = await mkdtemp(join(parent, 'selected-')), path = join(directory, 'input');
    let result: T;
    try {
      const before = await stat(source);
      if (!before.isFile() || before.size > MAX_ACCOUNT_BYTES) throw new UserMessage('Choose an exported account file.');
      await copyFile(source, path);
      const after = await stat(source);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || (await stat(path)).size !== before.size) throw new Error(`Selected file changed while being copied: ${source}`);
      result = await action(path);
    } catch (error) {
      await rm(directory, {recursive: true}).catch(cleanup => { throw new AggregateError([error, cleanup], String(error)); });
      throw error;
    }
    await rm(directory, {recursive: true}).catch(error => { throw new Error(`Finished ${JSON.stringify(result)}, but the private copy ${directory} could not be removed: ${String(error)}`); });
    return result;
  }
  beginImport(): Promise<ImportPreview | undefined> {
    let deliver!: (preview: ImportPreview | undefined) => void, reject!: (error: unknown) => void;
    const preview = new Promise<ImportPreview | undefined>((ok, bad) => { deliver = ok; reject = bad; });
    const outcome = this.runtime.stoppedOperation('Import player', async () => {
      try{if(!(await lstat(join(this.runtime.runtimePaths().state,'game.db'))).isFile())throw Error('Local save is not a regular file');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new UserMessage('Click Play once before importing so a full backup can be made.');throw error;}
      const source = await this.dialogs.choose();
      if (!source) return undefined;
      return this.staged(source, async path => {
        const { state, data } = this.runtime.runtimePaths();
        const email=JSON.parse(await readFile(path,'utf8')).email;
        if(!validLogin(email))throw new UserMessage('This export has no email. Export your account again.');
        let metadata:ImportPreview;
        try{metadata=await saveAuthority<ImportPreview>(this.runtime, 'preview', [state, data, path]);}
        catch(error){if(error instanceof AuthorityUnchangedError)throw new UserMessage('This file could not be read as an exported account. Your local save was not changed.',{cause:error});throw error;}
        if(metadata.login!==email)throw new Error(`Import preview login ${metadata.login} differs from the exported email`);
        if (this.runtime.view().closing) return undefined;
        const confirmation = new Promise<Confirmation | undefined>(accept => { this.pending = {preview: metadata, accept, outcome}; });
        deliver(metadata);
        const chosen = await confirmation;
        this.pending = undefined;
        if (!chosen) return undefined;
        try {
          await this.backupDirectory();
          const backup = this.backupPath(metadata.replaced ? 'pre-replace' : 'pre-import');
          const result = await saveAuthority<ImportPreview>(this.runtime, chosen.replace ? 'replace' : 'import', [state, data, path, backup, chosen.expected], chosen.password);
          if (result.account !== metadata.account || result.login !== metadata.login || result.replaced !== metadata.replaced) {
            const error = new Error('Import result differs from its preview; do not retry.');
            this.runtime.blockAmbiguousSave(error); throw error;
          }
          return {message: 'Account imported.', path: state, login: result.login};
        } finally { chosen.password = ''; }
      });
    });
    void outcome.then(() => deliver(undefined), reject);
    return preview;
  }
  finishImport(expected: unknown, password: unknown, confirmation: unknown, replace: unknown): Promise<SaveResult | undefined> {
    const pending = this.pending;
    if (!pending || expected !== pending.preview.expected || typeof replace !== 'boolean' || replace !== pending.preview.replaced) return Promise.reject(new Error('Import confirmation does not match the pending preview; cancel and preview again'));
    let checked: string;
    try { checked = checkedPassword(password, confirmation); } catch (error) { return Promise.reject(error); }
    this.pending = undefined;
    pending.accept({expected: pending.preview.expected, password: checked, replace});
    return pending.outcome;
  }
  async cancelImport(): Promise<boolean> {
    const pending = this.pending;
    if (!pending) return false;
    this.pending = undefined;
    pending.accept(undefined);
    await pending.outcome;
    return true;
  }
  listAccounts():Promise<LocalAccount[]>{return this.runtime.stoppedOperation('View local accounts',async()=>{const {state,data}=this.runtime.runtimePaths();return (await saveAuthority<{accounts:LocalAccount[]}>(this.runtime,'accounts',[state,data])).accounts;});}
  editAccount(account:unknown,expected:unknown,username:unknown,password:unknown):Promise<LocalAccount[]>{
    if(!positive(account)||typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected)||typeof username!=='string'||username.length>245)throw new UserMessage('Refresh the account list and enter a valid username.');
    const secret=password===''?null:checkedPassword(password,password);
    return this.runtime.stoppedOperation('Change local account',async()=>{await this.backupDirectory();const {state,data}=this.runtime.runtimePaths();try{return (await saveAuthority<{accounts:LocalAccount[]}>(this.runtime,'account-edit',[state,data,this.backupPath('pre-account-edit')],JSON.stringify({account,expected,username,password:secret}))).accounts;}catch(error){if(error instanceof AuthorityUnchangedError)throw new UserMessage('Account was not changed. Check the username, then refresh the account list. Details are in Advanced → Logs.',{cause:error});throw error;}});
  }
  makeBackup(): Promise<void> {
    return this.runtime.stoppedOperation('Make backup', async () => {
      await this.backupDirectory();
      const {state, data} = this.runtime.runtimePaths(), path = this.backupPath('manual');
      await saveAuthority(this.runtime, 'snapshot', [state, data, path]);
      await saveAuthority(this.runtime, 'verify-snapshot', [path, data]);
    });
  }
  async listBackups(): Promise<BackupFile[]> {
    await this.backupDirectory();
    const entries = await readdir(this.backups, {withFileTypes:true});
    const files = await Promise.all(entries.filter(entry => entry.isFile() && /\.(sqlite|db)$/.test(entry.name)).map(async entry => {
      const info = await stat(join(this.backups, entry.name));
      return {name:entry.name, modified:info.mtimeMs, bytes:info.size};
    }));
    return files.sort((a,b) => b.modified-a.modified || a.name.localeCompare(b.name));
  }
  restoreBackup(name: string): Promise<void> {
    return this.runtime.stoppedOperation('Restore backup', async () => {
      const source = join(this.backups, name), info = isBackupName(name) ? await lstat(source) : undefined;
      if (!info?.isFile()) throw new Error('Selected backup must be a regular file in the backup folder');
      const {state, data} = this.runtime.runtimePaths();
      const preview = await saveAuthority<SnapshotPreview>(this.runtime, 'verify-snapshot', [source, data]);
      if (!await this.dialogs.confirmRestore(preview, info.mtime.toLocaleString())) return;
      await saveAuthority(this.runtime, 'restore', [state, data, source, this.backupPath('pre-restore')]);
    });
  }
  private openFolder(name: string, path: string): Promise<void> {
    return this.runtime.stoppedOperation(name, async () => {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const error = await this.dialogs.openFolder(path);
      if (error) throw new Error(`Could not open ${path}: ${error}`);
    });
  }
  openSaveFolder() { return this.openFolder('Open save folder', this.runtime.userData); }
  openBackupFolder() { return this.openFolder('Open backup folder', this.backups); }
}
