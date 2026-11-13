import { spawn, execFileSync, ChildProcessByStdio, SpawnOptions } from 'node:child_process';
import { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { access, mkdir, readFile, writeFile, stat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { RuntimeUpdates } from './updates';

export type AuthorityCompletion = {command:string;binary:string;code:number;outcome:'success'|'unchanged';ack:unknown};

export type Status = 'stopped' | 'starting' | 'ready' | 'stopping' | 'failed';
export type View = { clientURL?: string; status: Status; message: string; logs: string[]; pid?: number; origin: string; diagnostics: string; consoleLog?:string; operation?: string; closing: boolean };
export const PORT = 47831;
const READY_MS = 600_000, STOP_MS = 45_000, MAX_LOG = 300;

// Cached runtime paths can reach MAX_PATH; native command syntax avoids false ENOENT without changing Windows policy.
export function serverCommandPath(binary:string,platform:NodeJS.Platform=process.platform){
  return platform==='win32'?win32.toNamespacedPath(binary):binary;
}

export function desktopServerSpawnOptions(platform: NodeJS.Platform, resources: string, env: NodeJS.ProcessEnv, logFd: number): SpawnOptions {
  // Windows libuv otherwise kills this child with the parent's job before its private EOF drain finishes.
  return { cwd: resources, env, windowsHide: true, detached: platform === 'win32', stdio: ['pipe', logFd, logFd] };
}

export class Runtime extends EventEmitter {
  private child?: ChildProcessByStdio<Writable, null, null>;
  private childClosed = false;
  private startSpawned = false;
  private diskError?: Error;
  private lines: string[] = [];
  private status: Status = 'stopped';
  private message = 'Server is stopped.';
  private listenerSeen = false;
  private expectedStop = false;
  private closed?: Promise<{ code: number | null; signal: string | null }>;
  private boot?: Promise<void>;
  private stopping?: Promise<void>;
  private unsafe = false;
  // Failure can precede Close; retain its IO outcome without an unhandled rejection or a second truncating write.
  private failureGate?: Promise<Error | undefined>;
  private failurePersistenceError?: Error;
  private operation?: Promise<unknown>;
  private operationName?: string;
  private closing = false;
  readonly origin = `http://127.0.0.1:${PORT}`;
  readonly diagnostics: string;
  private updates?: RuntimeUpdates;
  private selectedResources: string;
  constructor(resources: string, readonly userData: string, readonly storage: string = userData) {
    super();
    this.selectedResources = resources;
    this.diagnostics = join(storage, 'diagnostics');
  }
  get resources() { return this.selectedResources; }
  attachUpdates(updates: RuntimeUpdates) {
    if (this.updates || this.boot || this.operation || this.child || this.closing) throw new Error('Runtime update coordinator must attach before startup');
    this.updates = updates;
  }
  selectResources(resources: string) {
    if (this.child || (!this.boot && !this.operation)) throw new Error('Runtime selection requires stopped lifecycle ownership');
    this.selectedResources = resources;
  }
  ownsLiveChild(pid:number) { return this.child?.pid === pid && !this.childClosed; }
  isIdle() { return this.status === 'stopped' && !this.child && !this.operation && !this.boot && !this.stopping && !this.closing; }
  async authorityStarting(command:string,binary:string) { await this.updates?.authorityStarting(command,binary); }
  async authorityClosed(completion:AuthorityCompletion) { await this.updates?.authorityClosed(completion); }
  view(): View {
    return { status: this.status, message: this.message, logs: [...this.lines], pid: this.child?.pid, origin: this.origin, diagnostics: this.diagnostics, operation: this.operationName, closing: this.closing };
  }
  private update(status: Status, message: string) { this.status = status; this.message = message; this.emit('change', this.view()); }
  private line(text: string) {
    this.lines.push(text.slice(0, 2000));
    this.lines = this.lines.slice(-MAX_LOG);
    this.emit('change', this.view());
  }
  reportUpdate(message:string){const line=new Date().toISOString()+' [updates] '+message;this.line(line);console.info(line);}
  reportProblem(error:unknown){console.error(error);this.line(error instanceof Error?error.stack??error.message:String(error));}
  private fail(error: unknown) {
    this.unsafe = true;
    this.line(String(error));
    if (!this.failureGate) {
      this.failureGate = (this.updates&&process.platform==='win32'?Promise.resolve():mkdir(this.storage, { recursive: true, mode: 0o700 }))
        .then(() => this.updates ? this.updates.persistFailure(error) : writeFile(join(this.storage, 'shutdown-failed.json'), JSON.stringify({ at: new Date().toISOString(), error: String(error) }), { mode: 0o600, flush: true }))
        .then(() => undefined, cause => {
          const failure = new Error(`Could not persist shutdown failure: ${cause}. Failure gate is NOT recorded; launcher ownership must be retained.`);
          this.failurePersistenceError = failure;
          this.line(failure.message);
          this.update('failed', failure.message);
          return failure;
        });
    }
    if (this.failurePersistenceError) this.update('failed', this.failurePersistenceError.message);
    else this.update('failed', `${String(error)}. Save mutations are blocked; failure-gate persistence must complete before closing.`);
  }
  async verifyFailureGate(): Promise<void> {
    const error = await this.failureGate;
    if (error) throw error;
  }
  start(installedOnly = false): Promise<void> {
    if (this.closing || this.operation || this.status !== 'stopped' || this.boot || this.stopping) return Promise.reject(new Error('Start requires a verified stopped server and settled prior startup/shutdown'));
    this.startSpawned = false;
    this.update('starting', 'Checking installed runtime and save ownership…');
    this.boot = this.startOwned(installedOnly).catch(async error => {
      let updateFailure = false;
      try { updateFailure = await this.updates?.startFailed(error) ?? false; }
      catch(bookkeeping) { this.fail(new Error(`Startup failed: ${String(error)}; recovery bookkeeping also failed: ${String(bookkeeping)}`));throw bookkeeping; }
      if (this.child || this.unsafe || updateFailure) this.fail(error);
      else this.update('stopped', `Cannot start: ${String(error)}. No server is running.`);
      throw error;
    }).finally(() => { this.boot = undefined; setImmediate(()=>this.emit('change',this.view())); });
    return this.boot;
  }
  private async startOwned(installedOnly: boolean) {
    if(this.updates)await this.updates.prepareDiagnostics();else await mkdir(this.diagnostics, { recursive: true, mode: 0o700 });
    await this.updates?.beforeStart(installedOnly);
    if (this.closing && this.updates) throw this.updates.canceledBeforeSpawn();
    if (await this.exists(join(this.storage, 'shutdown-failed.json')) && !await this.updates?.failureAuthorized()) throw new Error('Previous server shutdown was not verified; see shutdown-failed.json');
    const { binary, data, client: clientPath, state } = this.runtimePaths();
    await access(binary, constants.R_OK | (process.platform === 'win32' ? 0 : constants.X_OK));
    const inventory = JSON.parse(await readFile(join(this.resources, 'inventory.json'), 'utf8')) as { files: string[] };
    for (const file of inventory.files) {
      if (resolve(this.resources, file) !== join(this.resources, file) || file.startsWith('..')) throw new Error('Invalid bundled asset path');
      if (!(await stat(join(this.resources, file))).isFile()) throw new Error(`Missing bundled asset: ${file}`);
    }
    await new Promise<void>((ok, bad) => {
      const probe = createServer();
      probe.once('error', error => bad(new Error(`Loopback port ${PORT} unavailable: ${error.message}. No other process was stopped.`)));
      probe.listen(PORT, '127.0.0.1', () => probe.close(error => error ? bad(error) : ok()));
    });
    let operational:Record<string,string>={};
    if(await this.exists(join(this.resources,'notices/account-management.json'))){
      const capability=JSON.parse(await readFile(join(this.resources,'notices/account-management.json'),'utf8'));if(capability.format!==1||capability.cli!==1||capability.storage!==1)throw Error('Invalid separate server-storage capability');
      const root=resolve(this.userData,'..');if(this.storage!==join(root,'server data','profile'))throw Error('Separate server storage requires native portable ownership');
      const prepared=JSON.parse(execFileSync(join(root,process.platform==='win32'?'OpenRotMG Singleplayer.exe':'OpenRotMG Singleplayer'),['--launcher-server-storage',root],{encoding:'utf8',windowsHide:true,timeout:30000}));
      if(prepared.profile!==join(this.storage,'server-state'))throw Error('Invalid native server-storage acknowledgement');operational={operational_state:prepared.profile};
    }
    const config = join(this.storage, 'desktop-config.json');
    await writeFile(config, JSON.stringify({ bind: `127.0.0.1:${PORT}`, origin: this.origin,
      data, client: clientPath, state, ...operational,
      behind_proxy: false, shore_bots: false, bot_llm: false, max_players: 85, realm_seed: 42, ...this.updates?.startupConfig() }, null, 2), { mode: 0o600 });
    await this.updates?.beforeSpawn(binary);
    const name = new Date().toISOString().replaceAll(':', '-');
    // Direct inherited file descriptors retain EOF-drain diagnostics even if Electron crashes.
    const log = await open(join(this.diagnostics, `${name}.jsonl`), 'wx+', 0o600);
    this.diskError = undefined;
    this.listenerSeen = false; this.expectedStop = false;
    // Environment is deliberately small: host bot/proxy/API-key settings cannot enter the consumer child.
    const env: NodeJS.ProcessEnv = { RUST_LOG: 'openrotmg=info,lag=info' };
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG']) if (process.env[key]) env[key] = process.env[key];
    const child = spawn(serverCommandPath(binary), ['--desktop', '--config', config], desktopServerSpawnOptions(process.platform, this.resources, env, log.fd)) as ChildProcessByStdio<Writable, null, null>;
    this.child = child;this.childClosed = false;this.startSpawned = true;
    this.closed = new Promise((ok) => {
      child.once('error', error => this.fail(new Error(`Server spawn failed: ${error.message}`)));
      child.once('close', async (code, signal) => {
        this.childClosed = true;
        clearInterval(tail);
        try { await reading; await refresh(); await log.sync(); } catch(error) { this.diskError = error as Error; this.fail(error); }
        await log.close().catch(error => { this.diskError = error; this.fail(error); });
        this.child = undefined;
        if (code === 0 && this.expectedStop && !this.diskError && !this.unsafe) {
          try { await this.updates?.cleanStop({code,signal,pid:child.pid!}); }
          catch(error) { this.fail(error); }
          if (!this.unsafe) this.update(this.boot ? 'stopping' : 'stopped', 'Server stopped. Durable shutdown verified (exit 0).');
        }
        else if (!this.listenerSeen && !this.expectedStop && !this.unsafe) {
          // Only the settled startup attempt may publish stopped and admit a replacement.
          this.line(`Server exited before listening: code=${code}, signal=${signal}`);
        } else {
          const error = new Error(`Server exited without verified shutdown: code=${code}, signal=${signal}`);
          this.fail(error);
        }
        await this.failureGate;
        ok({ code, signal });
      });
    });
    const closed = this.closed;
    let offset = 0, partial = '', reading: Promise<void> = Promise.resolve();
    const decoder = new StringDecoder('utf8');
    const refresh = async () => {
      const size = (await log.stat()).size;
      while (offset < size) {
        const bytes = Buffer.alloc(Math.min(65536, size - offset));
        const { bytesRead } = await log.read(bytes, 0, bytes.length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        partial += decoder.write(bytes.subarray(0, bytesRead));
        while (partial.includes('\n')) {
          const index = partial.indexOf('\n'), raw = partial.slice(0, index); partial = partial.slice(index + 1);
          try {
            const entry = JSON.parse(raw), fields = entry.fields;
            if (fields?.message === 'game frontdoor listening') this.listenerSeen = true;
            const details = fields ? Object.entries(fields).filter(([key, value]) => key !== 'message' && ['string', 'number', 'boolean'].includes(typeof value) && String(value).length <= 160).map(([key, value]) => `${key}=${value}`).join(' ') : '';
            this.line(`${entry.level ?? 'server'}: ${fields?.message ?? raw}${details ? ' · ' + details : ''}`);
          } catch { this.line(raw); }
        }
        if (partial.length > 8192) { this.line(partial.slice(0, 8192)); partial = ''; }
      }
    };
    const tail = setInterval(() => {
      reading = reading.then(refresh).catch(error => {
        this.diskError = error; this.fail(new Error(`Diagnostic read failed: ${error.message}`));
        void this.requestDrain().catch(error => this.fail(error));
      });
    }, 250);
    child.stdin.on('error', error => { if (this.child === child) this.fail(new Error(`Private shutdown pipe failed: ${error.message}`)); });
    try { await this.updates?.spawned(child.pid!); }
    catch(error) { await this.requestDrain(); throw error; }
    const deadline = performance.now() + READY_MS;
    while (this.child === child && this.status === 'starting' && performance.now() < deadline) {
      this.update('starting', `Preparing offline world… ${Math.ceil((READY_MS - (deadline - performance.now())) / 1000)}s / 600s. World generation can take several minutes.`);
      try {
        const response = await fetch(`${this.origin}/health`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
        if (response.ok) {
          const health = await response.json() as { process: number; bots: number; bot_dialogue: { enabled: boolean } };
          if (health.process !== child.pid) throw new Error(`Readiness PID mismatch: expected ${child.pid}, received ${health.process}`);
          if (health.bots !== 0 || health.bot_dialogue.enabled) throw new Error('Unsafe consumer health: bots/LLM enabled');
          if (this.listenerSeen) {
            await this.updates?.ready({pid:child.pid!,binary,resources:this.resources,healthProcess:health.process,listenerSeen:true});
            if (!this.ownsLiveChild(child.pid!) || this.unsafe || this.expectedStop || this.status !== 'starting') throw new Error('Owned server changed during durable startup bookkeeping; no playable-ready success is claimed');
            this.updates?.exposedReady();
            this.update('ready', `Offline server ready at ${this.origin}`); return;
          }
        }
      } catch (error) {
        if (!(error instanceof TypeError && error.cause && ['ECONNREFUSED', 'ECONNRESET'].includes((error.cause as NodeJS.ErrnoException).code ?? '')) && !(error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))) {
          await this.requestDrain(); throw error;
        }
      }
      await delay(500);
    }
    if (this.child !== child) {
      const result = await closed;
      if (result.code !== 0 || !this.expectedStop || this.unsafe || this.diskError) throw new Error(`Server exited before listening: code=${result.code}, signal=${result.signal}. Inspect diagnostics before retrying Start.`);
      return;
    }
    if (this.status === 'stopping' || this.expectedStop) return;
    await this.requestDrain();
    throw new Error('Server failed to become ready within the 600 second deadline; see diagnostics');
  }
  private async exists(path: string) { try { await access(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
  private async requestDrain() {
    if (!this.child) return;
    if (!this.expectedStop) { this.expectedStop = true; this.child.stdin.end('stop\n'); }
    const deadline = this.listenerSeen ? STOP_MS : READY_MS + STOP_MS;
    const timer = new AbortController();
    try {
      const result = await Promise.race([this.closed!, delay(deadline, undefined, { signal: timer.signal }).then(() => { throw new Error(`Shutdown exceeded ${deadline / 1000} seconds; process was NOT force-killed and save success is unknown`); })]);
      await this.verifyFailureGate();
      if (result.code !== 0 || this.diskError || this.unsafe) throw new Error(`Shutdown failed: exit=${result.code}, signal=${result.signal}, diagnostic error=${this.diskError?.message ?? 'none'}`);
    } finally { timer.abort(); }
  }
  /** Holds lifecycle ownership through dialogs, authority children and cleanup, not just the database write. */
  stoppedOperation<T>(name: string, action: () => Promise<T>): Promise<T> { return this.reserveOperation(name,action,'save'); }
  idleOperation<T>(name:string,action:()=>Promise<T>):Promise<T> { return this.reserveOperation(name,action,'update'); }
  recoveryOperation<T>(name:string,action:()=>Promise<T>):Promise<T> { return this.reserveOperation(name,action,'recovery'); }
  private reserveOperation<T>(name:string,action:()=>Promise<T>,kind:'save'|'update'|'recovery'):Promise<T> {
    if (this.closing || this.operation || this.boot || this.stopping || this.status === 'starting' || this.status === 'stopping' || (kind !== 'save' && this.child) || (kind === 'update' && this.status !== 'stopped')) return Promise.reject(new Error('Another lifecycle operation is in progress'));
    this.operationName = name;
    const operation = Promise.resolve().then(async () => {
      if (kind === 'save') await this.stopOwned();
      if (kind === 'recovery' && this.closed) await this.closed;
      await this.verifyFailureGate();
      if (kind !== 'recovery') {
        if (this.unsafe || (await this.exists(join(this.storage, 'shutdown-failed.json')) && !await this.updates?.failureAuthorized())) throw new Error('Previous shutdown was not verified; save operations are blocked');
        if (kind === 'save') await this.updates?.beforeSave();
      }
      return action();
    }).finally(() => {
      this.operation = undefined; this.operationName = undefined; this.emit('change', this.view());
    });
    this.operation = operation;
    this.emit('change', this.view());
    return operation;
  }
  async close(): Promise<void> {
    this.closing = true;
    this.updates?.abort();
    this.emit('change', this.view());
    try {
      if (this.operation) await this.operation;
      await this.stopOwned();
      await this.updates?.settle();
      await this.verifyFailureGate();
    } catch (error) { this.closing = false; this.emit('change', this.view()); throw error; }
  }
  async completeUpdateRecovery(receiptSha256:string) {
    if (!this.operation || this.child || this.boot || this.stopping || this.closing || !this.updates) throw new Error('Updater recovery requires exclusive stopped ownership');
    await this.updates.verifyRecoveryComplete(receiptSha256);
    this.updates.recoveryAcknowledged();
    this.unsafe = false;this.failureGate = undefined;this.failurePersistenceError = undefined;
    this.update('stopped','Current save recovered/verified. Previous failure evidence is retained; no clean shutdown is claimed for that failure.');
  }
  clientURL() { return this.updates ? this.updates.clientURL() : this.origin + '/'; }
  runtimePaths() {
    return { binary: join(this.resources, process.platform === 'win32' ? 'openrotmg.exe' : 'openrotmg'), data: join(this.resources, 'data'), client: join(this.resources, 'client'), state: join(this.userData, 'state') };
  }
  blockAmbiguousSave(error: Error) { this.fail(error); }
  stop(): Promise<void> {
    if (this.operation || this.closing) return Promise.reject(new Error('Another lifecycle operation is in progress'));
    return this.stopOwned();
  }
  private stopOwned(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.status === 'stopped') return Promise.resolve();
    if (this.status === 'failed' && !this.child) return Promise.reject(new Error(`Previous operation failed; recovery is required. ${this.message}`));
    this.update('stopping', 'Saving active characters and stopping server…');
    this.stopping = (async () => {
      // Start may still be validating files; do not release ownership until its promise settles.
      if (!this.child) {
        try { await this.boot; }
        catch(error) {
          if (!this.startSpawned && !this.unsafe && this.updates?.canCancelStart()) { this.update('stopped','Startup canceled before any server process was invoked. Pending update intent is retained; no game shutdown is claimed.');return; }
          throw error;
        }
      }
      await this.requestDrain();
      await this.boot;
      if (!this.child && !this.unsafe && this.expectedStop) this.update('stopped', 'Server stopped. Durable shutdown verified (exit 0).');
    })().catch(error => { this.fail(error); throw error; }).finally(() => { this.stopping = undefined; setImmediate(()=>this.emit('change',this.view())); });
    return this.stopping;
  }
}
