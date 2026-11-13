import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, rm, stat, realpath, readdir, lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Runtime, serverCommandPath } from './runtime';

import {UserMessage} from './user-message';

export type ImportPreview = { account: number; login: string; replaced: boolean; disclosure: string; exported_at: number; name: string; character_count: number; expected: string };
export type SnapshotPreview = { verified: true; schema: number; scope: 'all-local-accounts'; account_count: number; character_count: number };
export type SaveResult = { message: string; path?: string; login?: string; disclosure?: string };
export type LocalAccount = {account:number;name:string;username:string|null;password:string|null;expected:string};
export function accountList(value:unknown):LocalAccount[]{
  const result=value as {accounts:LocalAccount[]};
  if(!result||Object.keys(result).length!==1||!Array.isArray(result.accounts)||result.accounts.some(a=>!a||Object.keys(a).sort().join(',')!=='account,expected,name,password,username'||!positive(a.account)||typeof a.name!=='string'||!(a.username===null||typeof a.username==='string')||!(a.password===null||typeof a.password==='string')||typeof a.expected!=='string'||!/^[a-f0-9]{64}$/.test(a.expected)))throw Error('Invalid local account authority acknowledgement');
  if(new Set(result.accounts.map(a=>a.account)).size!==result.accounts.length)throw Error('Duplicate local account acknowledgement');
  return result.accounts;
}
export type BackupFile = { name: string; modified: number; bytes: number };
export const isBackupName = (name: unknown): name is string => typeof name === 'string' && name.length <= 255 && /\.(sqlite|db)$/.test(name) && !/[<>:"|?*]/.test(name) && !/\p{Cc}/u.test(name) && !name.includes('/') && !name.includes('\\');
export type SaveDialogs = {
  choose(kind: 'account' | 'snapshot', directory: string): Promise<string | undefined>;
  confirmRestore(preview: SnapshotPreview, path: string, modified: string): Promise<boolean>;
  openFolder(path: string): Promise<string>;
};
const MAX_ACCOUNT_BYTES = 32 * 1024 * 1024, MAX_OUTPUT_BYTES = 64 * 1024;
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
export function importPreview(value: unknown): ImportPreview {
  const p = value as ImportPreview;
  if (!p || Object.keys(p).length !== 8 || !positive(p.account) || typeof p.login !== 'string' || p.login !== `player-${p.account}@local.invalid` || typeof p.replaced !== 'boolean' || typeof p.disclosure !== 'string' || (!positive(p.exported_at) || p.exported_at > 8_640_000_000_000) || typeof p.name !== 'string' || !count(p.character_count) || typeof p.expected !== 'string' || !/^[a-f0-9]{64}$/.test(p.expected)) throw new Error('Invalid authority import preview; expected account/login/date/name/count/precondition metadata');
  return p;
}
export function snapshotPreview(value: unknown): SnapshotPreview {
  const p = value as SnapshotPreview;
  if (!p || Object.keys(p).length !== 5 || p.verified !== true || ![21, 22, 23].includes(p.schema) || p.scope !== 'all-local-accounts' || !count(p.account_count) || !count(p.character_count)) throw new Error('Invalid authority snapshot metadata; expected verified schema/scope/account/character counts');
  return p;
}
export function checkedPassword(value: unknown, confirmation: unknown): string {
  if (typeof value !== 'string' || typeof confirmation !== 'string' || value !== confirmation || Buffer.from(value, 'utf8').toString('utf8') !== value || Buffer.byteLength(value) < 5 || Buffer.byteLength(value) > 128 || /\p{Cc}/u.test(value)) throw new UserMessage(value!==confirmation?'The passwords do not match. Enter the same password in both boxes.':'Choose a different password. Try at least five ordinary letters or numbers, without line breaks.');
  return value;
}

export class AuthorityUnchangedError extends Error { constructor(message:string,options?:ErrorOptions) { super(message,options);this.name='AuthorityUnchangedError'; } }

/** Only server-owned named save commands are reachable here; paths never come from IPC. */
export type SaveAuthorityRuntime = Pick<Runtime,'runtimePaths'|'resources'|'blockAmbiguousSave'|'authorityStarting'|'authorityClosed'>;
export async function saveAuthority(runtime: SaveAuthorityRuntime, command: 'preview' | 'import' | 'replace' | 'snapshot' | 'verify-snapshot' | 'restore' | 'accounts' | 'account-edit', paths: string[], password?: string): Promise<unknown> {
  const { binary } = runtime.runtimePaths();
  await runtime.authorityStarting(command,binary);
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
  if (spawnError) throw unverified(`could not start: ${spawnError.message}`);
  if (signal || overflow || (pipeError && (code === 0 || (pipeError as NodeJS.ErrnoException).code !== 'EPIPE'))) throw unverified(`exit=${code}, signal=${signal}, outputLimit=${overflow}, stdin=${pipeError?.message ?? 'closed'}`);
  if (code === null) throw unverified('child closed without an exit status');
  let result: unknown;
  try { result = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(output)); }
  catch { throw unverified(`exit=${code}; invalid outcome JSON`); }
  if (code !== 0) {
    const failure = result as {protocol: number; operation: string; outcome: string; error: string};
    if (!failure || Object.keys(failure).length !== 4 || failure.protocol !== 1 || failure.operation !== command || !['unchanged', 'unknown'].includes(failure.outcome) || typeof failure.error !== 'string' || !failure.error.trim() || Buffer.byteLength(failure.error) > MAX_OUTPUT_BYTES) throw unverified(`exit=${code}; invalid failure envelope (protocol/operation/outcome/error)`);
    if (failure.outcome === 'unknown') throw unverified(`exit=${code}; ${failure.error}`);
    await runtime.authorityClosed({command,binary,code,outcome:'unchanged',ack:failure});
    throw new AuthorityUnchangedError(`Save authority ${command} failed (exit ${code}) at ${binary}: ${failure.error}. Destination game save unchanged; output/backup files may exist. No output success is claimed.`);
  }
  try {
    if (command === 'preview') importPreview(result);
    else if (command === 'verify-snapshot') snapshotPreview(result);
    else if (command === 'snapshot') {
      const value = result as {snapshot: string; verified: boolean};
      if (!value || Object.keys(value).length !== 2 || value.snapshot !== paths[2] || value.verified !== true) throw new Error('invalid snapshot acknowledgement');
    } else if (command === 'restore') {
      const value = result as {restored: boolean; backup: string};
      if (!value || Object.keys(value).length !== 2 || value.restored !== true || value.backup !== paths[3]) throw new Error('invalid restore acknowledgement');
    } else if(command==='accounts'||command==='account-edit'){
      accountList(result);
    } else {
      const value = result as ImportPreview;
      if (!value || Object.keys(value).length !== 4 || !positive(value.account) || value.login !== `player-${value.account}@local.invalid` || typeof value.replaced !== 'boolean' || typeof value.disclosure !== 'string') throw new Error('invalid import acknowledgement');
    }
  } catch (error) { throw unverified(`invalid success acknowledgement: ${String(error)}`); }
  await runtime.authorityClosed({command,binary,code,outcome:'success',ack:command==='accounts'||command==='account-edit'?{accounts:accountList(result).map(({password,...row})=>row)}:result});
  return result;
}
function authorityEnvironment() {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG']) if (process.env[key]) env[key] = process.env[key];
  return env;
}

async function retainCleanup<T>(action: () => Promise<T>, cleanup: () => Promise<void>, label: string): Promise<T> {
  let primary: unknown, failed = false;
  try { return await action(); }
  catch (error) { failed = true; primary = error; throw error; }
  finally {
    try { await cleanup(); }
    catch (error) { throw new Error(`${failed ? `Primary error: ${String(primary)}. ` : ''}${label} failed: ${String(error)}`); }
  }
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
  private async snapshotWithoutWal(source: string) {
    // A live SQLite checkpoint can validate while silently omitting committed progress still in its WAL.
    try { if ((await stat(source + '-wal')).size > 0) throw new Error(`Selected file has an active WAL: ${source}. Choose a verified full backup made by Make backup, not a live database file.`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private async staged<T>(source: string, kind: 'account' | 'snapshot', action: (path: string, modified: string) => Promise<T>): Promise<T> {
    const limit = kind === 'account' ? MAX_ACCOUNT_BYTES : undefined;
    const parent = join(this.runtime.storage, 'save-staging');
    await mkdir(parent, {recursive: true, mode: 0o700});
    const directory = await mkdtemp(join(parent, 'selected-'));
    let primary: unknown, completed = false;
    let outcome: T | undefined;
    try {
      const selected = await realpath(source);
      if (kind === 'snapshot') await this.snapshotWithoutWal(selected);
      const input = await open(selected, 'r');
      const modified = await retainCleanup(async () => {
        const info = await input.stat();
        if (!info.isFile()) throw new Error(`Selected save is not a regular file: ${source}`);
        if (limit !== undefined && info.size > limit) throw new Error(`Selected account file exceeds ${limit} bytes: ${source}`);
        const output = await open(join(directory, 'input'), 'wx', 0o600);
        await retainCleanup(async () => {
          let total = 0;
          const buffer = Buffer.alloc(64 * 1024);
          while (total < info.size) {
            const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, info.size - total), null);
            if (!bytesRead) throw new Error('Selected save changed while being staged; choose it again');
            total += bytesRead;
            let offset = 0;
            while (offset < bytesRead) {
              const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset);
              if (!bytesWritten) throw new Error('Save staging write made no progress');
              offset += bytesWritten;
            }
          }
          const extra = await input.read(Buffer.alloc(1), 0, 1, null), after = await input.stat();
          if (extra.bytesRead || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('Selected save changed while being staged; choose it again');
          await output.sync();
        }, () => output.close(), 'Close private staging file');
        return info.mtime.toISOString();
      }, () => input.close(), 'Close selected input file');
      if (kind === 'snapshot') await this.snapshotWithoutWal(selected);
      outcome = await action(join(directory, 'input'), modified);
      completed = true;
      return outcome;
    } catch (error) { primary = new Error(`Selected save ${source}: ${String(error)}`,{cause:error}); throw primary; }
    finally {
      try { await rm(directory, {recursive: true}); }
      catch (cleanup) { throw new Error(`${completed ? `Operation completed: ${JSON.stringify(outcome)}. ` : `Primary error: ${String(primary)}. `}Save staging cleanup failed at ${directory}: ${String(cleanup)}. Do not repeat a possibly completed operation without inspecting its outcome.`,{cause:primary}); }
    }
  }
  beginImport(): Promise<ImportPreview | undefined> {
    let deliver!: (preview: ImportPreview | undefined) => void, reject!: (error: unknown) => void;
    const preview = new Promise<ImportPreview | undefined>((ok, bad) => { deliver = ok; reject = bad; });
    const outcome = this.runtime.stoppedOperation('Import player', async () => {
      const source = await this.dialogs.choose('account', this.backups);
      if (!source) return undefined;
      return this.staged(source, 'account', async path => {
        const { state, data } = this.runtime.runtimePaths();
        let metadata:ImportPreview;
        try{metadata=importPreview(await saveAuthority(this.runtime, 'preview', [state, data, path]));}
        catch(error){if(error instanceof AuthorityUnchangedError)throw new AuthorityUnchangedError('The installed server could not read this save. Check Server + client updates, then choose the file again. Your local save was not changed.',{cause:error});throw error;}
        if (this.runtime.view().closing) return undefined;
        const confirmation = new Promise<Confirmation | undefined>(accept => { this.pending = {preview: metadata, accept, outcome}; });
        deliver(metadata);
        const chosen = await confirmation;
        this.pending = undefined;
        if (!chosen) return undefined;
        try {
          await this.backupDirectory();
          const backup = this.backupPath(metadata.replaced ? 'pre-replace' : 'pre-import');
          const value = await saveAuthority(this.runtime, chosen.replace ? 'replace' : 'import', [state, data, path, backup, chosen.expected], chosen.password);
          const result = value as ImportPreview;
          if (!result || result.account !== metadata.account || result.login !== metadata.login || result.replaced !== metadata.replaced || typeof result.disclosure !== 'string') {
            const error = new Error('Import outcome differs from confirmed preview; completion is unverified. Retain state and backups; do not retry.');
            this.runtime.blockAmbiguousSave(error); throw error;
          }
          return {message: `Player imported. Sign in locally with ${result.login} and your new password.`, path: state, login: result.login, disclosure: result.disclosure};
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
  private async requireAccounts(){
    let bytes:Buffer;try{bytes=await readFile(join(this.runtime.resources,'notices/account-management.json'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new UserMessage('Install the Server + client update before managing accounts.');throw error;}
    const value=JSON.parse(bytes.toString('utf8'));if(Object.keys(value).sort().join(',')!=='cli,format,server,storage'||value.format!==1||value.cli!==1||value.storage!==1||typeof value.server!=='string'||!/^[a-f0-9]{40}$/.test(value.server))throw Error('Invalid authenticated account-management capability');
    if(value.server!==(await readFile(join(this.runtime.resources,'REVISION'),'utf8')).trim())throw Error('Account-management capability does not match the selected server');
  }
  listAccounts():Promise<LocalAccount[]>{return this.runtime.stoppedOperation('View local accounts',async()=>{await this.requireAccounts();const {state,data}=this.runtime.runtimePaths();return accountList(await saveAuthority(this.runtime,'accounts',[state,data]));});}
  editAccount(account:unknown,expected:unknown,username:unknown,password:unknown):Promise<LocalAccount[]>{
    if(!positive(account)||typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected)||typeof username!=='string'||username.length>245)throw new UserMessage('Refresh the account list and enter a valid username.');
    const secret=password===''?null:checkedPassword(password,password);
    return this.runtime.stoppedOperation('Change local account',async()=>{await this.requireAccounts();await this.backupDirectory();const {state,data}=this.runtime.runtimePaths();try{return accountList(await saveAuthority(this.runtime,'account-edit',[state,data,this.backupPath('pre-account-edit')],JSON.stringify({account,expected,username,password:secret})));}catch(error){if(error instanceof AuthorityUnchangedError)throw new UserMessage('Account was not changed. Check the username and backup folder, then refresh the account list. Details are in Advanced → Logs.',{cause:error});throw error;}});
  }
  makeBackup(): Promise<SaveResult> {
    return this.runtime.stoppedOperation('Make backup', async () => {
      await this.backupDirectory();
      const {state, data} = this.runtime.runtimePaths(), path = this.backupPath('manual');
      const result = await saveAuthority(this.runtime, 'snapshot', [state, data, path]) as {snapshot: string; verified: boolean};
      if (result?.snapshot !== path || result.verified !== true) throw new Error(`Unverified snapshot outcome at ${path}; no backup success claimed`);
      snapshotPreview(await saveAuthority(this.runtime, 'verify-snapshot', [path, data]));
      return {message:'Backup created.', path};
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
  restoreBackup(name?: string): Promise<SaveResult | undefined> {
    return this.runtime.stoppedOperation('Restore backup', async () => {
      if (name !== undefined && (!isBackupName(name) || !(await lstat(join(this.backups,name))).isFile())) throw new Error('Selected backup must be a regular file in the backup folder');
      const source = name === undefined ? await this.dialogs.choose('snapshot', this.backups) : join(this.backups,name);
      if (!source) return undefined;
      return this.staged(source, 'snapshot', async (path, modified) => {
        const {state, data} = this.runtime.runtimePaths();
        const preview = snapshotPreview(await saveAuthority(this.runtime, 'verify-snapshot', [path, data]));
        if (!await this.dialogs.confirmRestore(preview, source, modified)) return undefined;
        await this.backupDirectory();
        const backup = this.backupPath('pre-restore');
        const result = await saveAuthority(this.runtime, 'restore', [state, data, path, backup]) as {restored: boolean; backup: string};
        if (result?.restored !== true || result.backup !== backup) {
          const error = new Error(`Restore outcome is unverified; retain state and ${backup}; do not retry.`);
          this.runtime.blockAmbiguousSave(error); throw error;
        }
        return {message: 'Backup restored, including original local logins and passwords.', path: backup};
      });
    });
  }
  openSaveFolder(): Promise<SaveResult> {
    return this.runtime.stoppedOperation('Open save folder', async () => {
      const error = await this.dialogs.openFolder(this.runtime.userData);
      if (error) throw new Error(`Could not open save folder ${this.runtime.userData}: ${error}`);
      return {message:'Save folder opened.',path:this.runtime.userData};
    });
  }
  openBackupFolder(): Promise<SaveResult> {
    return this.runtime.stoppedOperation('Open backup folder', async () => {
      await this.backupDirectory();
      const error = await this.dialogs.openFolder(this.backups);
      if (error) throw new Error(`Could not open backup folder ${this.backups}: ${error}`);
      return {message: 'Backup folder opened.', path: this.backups};
    });
  }
}
