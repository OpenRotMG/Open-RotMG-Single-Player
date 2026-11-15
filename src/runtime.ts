import { spawn, execFileSync, ChildProcessByStdio, SpawnOptions } from 'node:child_process';
import { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {LocalSettings} from './settings';
import {launchFailure} from './diagnostics';

export type Status = 'stopped' | 'starting' | 'ready' | 'stopping' | 'failed';
export type View = { clientURL?: string; status: Status; message: string; logs: string[]; pid?: number; origin: string; diagnostics: string; operation?: string; closing: boolean; botsEnabled:boolean };
export const PORT = 47831;
const READY_MS = 600_000, STOP_MS = 45_000, MAX_LOG = 300;

// Long portable paths can reach MAX_PATH; native command syntax avoids false ENOENT without changing Windows policy.
export function serverCommandPath(binary:string,platform:NodeJS.Platform=process.platform){
  return platform==='win32'?win32.toNamespacedPath(binary):binary;
}

export function desktopServerSpawnOptions(platform: NodeJS.Platform, resources: string, env: NodeJS.ProcessEnv, logFd: number): SpawnOptions {
  // Windows libuv otherwise kills this child with the parent's job before its private EOF drain finishes.
  return { cwd: resources, env, windowsHide: true, detached: platform === 'win32', stdio: ['pipe', logFd, logFd] };
}

/** Runs the server bundled with this exact launcher build; there is no separately installed server. */
export class Runtime extends EventEmitter {
  private child?: ChildProcessByStdio<Writable, null, null>;
  private diskError?: Error;
  private lines: string[] = [];
  private status: Status = 'stopped';
  private message = 'Server is stopped.';
  private listenerSeen = false;
  private expectedStop = false;
  private closed?: Promise<{ code: number | null; signal: string | null }>;
  private boot?: Promise<void>;
  private stopping?: Promise<void>;
  private operation?: Promise<unknown>;
  private operationName?: string;
  private closing = false;
  private generation?: string;
  private lastServerError?: string;
  private lastServerLine?: string;
  failure?: Error;
  readonly origin = `http://127.0.0.1:${PORT}`;
  readonly diagnostics: string;
  private settings:LocalSettings;
  constructor(private selected: string, readonly userData: string, readonly storage: string = userData) {
    super();
    this.settings=new LocalSettings(storage);
    this.diagnostics = join(storage, 'diagnostics');
  }
  async loadSettings(){await this.settings.load();}
  get resources() { return this.selected; }
  select(resources: string) { if (this.child || this.status !== 'stopped') throw new Error('Stop the game before switching servers'); this.selected = resources; this.emit('change', this.view()); }
  setBots(enabled:boolean){return this.reserveOperation('Configure local bots',async()=>{if(this.status!=='stopped')throw new Error('Save & stop the game before changing bots');await this.settings.setBots(enabled);this.reportUpdate('Local bots '+(enabled?'enabled':'disabled')+' for the next game start.');},false);}
  view(): View {
    return { status: this.status, message: this.message, logs: [...this.lines], pid: this.child?.pid, origin: this.origin, diagnostics: this.diagnostics, operation: this.operationName, closing: this.closing, botsEnabled:this.settings.bots };
  }
  private update(status: Status, message: string) { this.status = status; this.message = message; this.emit('change', this.view()); }
  private line(text: string) {
    this.lines.push(text.slice(0, 2000));
    this.lines = this.lines.slice(-MAX_LOG);
    this.emit('change', this.view());
  }
  reportUpdate(message:string){const line=new Date().toISOString()+' [updates] '+message;this.line(line);console.info(line);}
  reportProblem(error:unknown){console.error(error);this.line(error instanceof Error?error.stack??error.message:String(error));}
  /** Blocks further saves this session; the server's state lock and startup backup protect the next launch. */
  private fail(error: unknown) {
    this.failure = error instanceof Error ? error : new Error(String(error));this.emit('event', 'failed', {error: String(error)});
    console.error(error);this.line(String(error));
    this.update('failed', `${String(error)}. Save actions are blocked until the launcher is reopened.`);
  }
  blockAmbiguousSave(error: Error) { this.fail(error); }
  start(): Promise<void> {
    if (this.closing || this.operation || this.status !== 'stopped' || this.boot || this.stopping) return Promise.reject(new Error('Start requires a stopped server'));
    this.update('starting', 'Checking game files…');
    this.boot = this.startOwned().catch(error => {
      if (this.child || this.status === 'failed') this.fail(error);
      else this.update('stopped', `Cannot start: ${String(error)}. No server is running.`);
      throw error;
    }).finally(() => { this.boot = undefined; setImmediate(()=>this.emit('change',this.view())); });
    return this.boot;
  }
  private async startOwned() {
    await mkdir(this.diagnostics, { recursive: true, mode: 0o700 });
    await this.settings.load();
    const { binary, data, client: clientPath, state } = this.runtimePaths();
    await access(binary, constants.R_OK | (process.platform === 'win32' ? 0 : constants.X_OK));
    // Each build serves its client under its own path so a browser never reuses an older client from cache.
    const started = performance.now(), buildIdentity = await readFile(join(this.resources, 'build-identity.json'));
    this.generation = createHash('sha256').update(buildIdentity).digest('hex');this.lastServerError = undefined;this.lastServerLine = undefined;this.failure = undefined;
    await new Promise<void>((ok, bad) => {
      const probe = createServer();
      probe.once('error', error => bad(new Error(`Loopback port ${PORT} unavailable: ${error.message}. No other process was stopped.`)));
      probe.listen(PORT, '127.0.0.1', () => probe.close(error => error ? bad(error) : ok()));
    });
    let operational:Record<string,string>={};
    if(this.storage!==this.userData){
      const root=resolve(this.userData,'..');if(this.storage!==join(root,'server data','profile'))throw Error('Separate server storage requires native portable ownership');
      const prepared=JSON.parse(execFileSync(join(root,process.platform==='win32'?'OpenRotMG Singleplayer.exe':'OpenRotMG Singleplayer'),['--launcher-server-storage',root],{encoding:'utf8',windowsHide:true,timeout:30000}));
      if(prepared.profile!==join(this.storage,'server-state'))throw Error('Invalid native server-storage acknowledgement');operational={operational_state:prepared.profile};
    }
    const backups = join(this.userData, 'backups');await mkdir(backups, { recursive: true, mode: 0o700 });
    const config = join(this.storage, 'desktop-config.json');
    await writeFile(config, JSON.stringify({ bind: `127.0.0.1:${PORT}`, origin: this.origin,
      data, client: clientPath, state, ...operational, client_generation: this.generation,
      // The server writes and verifies this full backup before it may migrate or open the save.
      pre_migration_backup: join(backups, `${Date.now()}-pre-start-${randomUUID()}.sqlite`),
      behind_proxy: false, shore_bots: this.settings.bots, bot_llm: false, max_players: 85, realm_seed: 42 }, null, 2), { mode: 0o600 });
    const name = new Date().toISOString().replaceAll(':', '-');
    // Direct inherited file descriptors retain EOF-drain diagnostics even if Electron crashes.
    const log = await open(join(this.diagnostics, `${name}.jsonl`), 'wx+', 0o600);
    this.diskError = undefined;
    this.listenerSeen = false; this.expectedStop = false;
    // Environment is deliberately small: host bot/proxy/API-key settings cannot enter the consumer child.
    const env: NodeJS.ProcessEnv = { RUST_LOG: 'openrotmg=info,lag=info' };
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG']) if (process.env[key]) env[key] = process.env[key];
    const expected = JSON.parse(buildIdentity.toString()).binarySha256;
    let child: ChildProcessByStdio<Writable, null, null>;
    // Windows reports most refusals synchronously; missing files arrive later as an 'error' event.
    try { child = spawn(serverCommandPath(binary), ['--desktop', '--config', config], desktopServerSpawnOptions(process.platform, this.resources, env, log.fd)) as ChildProcessByStdio<Writable, null, null>; }
    catch (error) { await log.close(); throw await launchFailure(binary, error as NodeJS.ErrnoException, expected); }
    if (child.pid === undefined) {
      const error = await new Promise<NodeJS.ErrnoException>(ok => child.once('error', ok));
      await log.close();
      throw await launchFailure(binary, error, expected);
    }
    this.emit('event', 'server spawned', {pid: child.pid, server: this.resources});
    this.child = child;
    this.closed = new Promise((ok) => {
      child.once('error', error => this.fail(new Error(`Server spawn failed: ${error.message}`)));
      child.once('close', async (code, signal) => {
        clearInterval(tail);
        try { await reading; await refresh(); await log.sync(); } catch(error) { this.diskError = error as Error; this.fail(error); }
        await log.close().catch(error => { this.diskError = error; this.fail(error); });
        this.child = undefined;
        if (code === 0 && this.expectedStop && !this.diskError && this.status !== 'failed') this.update(this.boot ? 'stopping' : 'stopped', 'Server stopped. Save verified (exit 0).');
        else if (!this.listenerSeen && !this.expectedStop && this.status !== 'failed') this.line(`Server exited before listening: code=${code}, signal=${signal}`);
        else this.fail(new Error(`Server exited without verified shutdown: code=${code}, signal=${signal}${this.lastServerError ? `; its last error was: ${this.lastServerError}` : ''}`));
        this.emit('event', 'server exited', {code, signal, seconds: Math.round((performance.now() - started) / 1000)});
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
            this.lastServerLine = String(fields?.message ?? raw).slice(0, 300);
            if (/^(ERROR|WARN)$/.test(entry.level ?? '')) this.lastServerError = this.lastServerLine;
            const details = fields ? Object.entries(fields).filter(([key, value]) => key !== 'message' && ['string', 'number', 'boolean'].includes(typeof value) && String(value).length <= 160).map(([key, value]) => `${key}=${value}`).join(' ') : '';
            this.line(`${entry.level ?? 'server'}: ${fields?.message ?? raw}${details ? ' · ' + details : ''}`);
          } catch { this.lastServerLine = raw.slice(0, 300); if (/panicked|error/i.test(raw)) this.lastServerError = this.lastServerLine; this.line(raw); }
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
    const deadline = performance.now() + READY_MS;
    while (this.child === child && this.status === 'starting' && performance.now() < deadline) {
      this.update('starting', `Preparing offline world… ${Math.ceil((READY_MS - (deadline - performance.now())) / 1000)}s / 600s. World generation can take several minutes.`);
      try {
        const response = await fetch(`${this.origin}/health`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
        if (response.ok) {
          const health = await response.json() as { process: number; bots: number; bot_dialogue: { enabled: boolean } };
          if (health.process !== child.pid) throw new Error(`Readiness PID mismatch: expected ${child.pid}, received ${health.process}`);
          if (!Number.isInteger(health.bots)||health.bots<0||(!this.settings.bots&&health.bots!==0)||health.bot_dialogue.enabled) throw new Error('Local server health does not match the configured bots/disabled language service');
          if (this.listenerSeen) { this.emit('event', 'server ready', {seconds: Math.round((performance.now() - started) / 1000), bots: health.bots}); this.update('ready', `Offline server ready at ${this.origin}`); return; }
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
      if (result.code !== 0 || !this.expectedStop || this.diskError) throw new Error(`The game server closed while starting (exit code ${result.code}${result.signal ? `, ${result.signal}` : ''})${this.lastServerError ?? this.lastServerLine ? `. Its last output: ${this.lastServerError ?? this.lastServerLine}` : ''}`);
      return;
    }
    if (this.status === 'stopping' || this.expectedStop) return;
    await this.requestDrain();
    throw new Error('Server was not ready after 600 seconds; see diagnostics');
  }
  private async requestDrain() {
    if (!this.child) return;
    if (!this.expectedStop) { this.expectedStop = true; this.child.stdin.end('stop\n'); }
    const deadline = this.listenerSeen ? STOP_MS : READY_MS + STOP_MS;
    const timer = new AbortController();
    try {
      const result = await Promise.race([this.closed!, delay(deadline, undefined, { signal: timer.signal }).then(() => { throw new Error(`Shutdown exceeded ${deadline / 1000} seconds; process was NOT force-killed and save success is unknown`); })]);
      if (result.code !== 0 || this.diskError || this.status === 'failed') throw new Error(`Shutdown failed: exit=${result.code}, signal=${result.signal}, diagnostic error=${this.diskError?.message ?? 'none'}`);
    } finally { timer.abort(); }
  }
  /** Saves and stops the game, then holds lifecycle ownership through dialogs and save tools. */
  stoppedOperation<T>(name: string, action: () => Promise<T>): Promise<T> { return this.reserveOperation(name,action,true); }
  private reserveOperation<T>(name:string,action:()=>Promise<T>,stopFirst:boolean):Promise<T> {
    if (this.closing || this.operation || this.boot || this.stopping || this.status === 'starting' || this.status === 'stopping') return Promise.reject(new Error('Another lifecycle operation is in progress'));
    if (this.status === 'failed') return Promise.reject(new Error('The last save was not confirmed. Close and reopen the launcher before changing saves.'));
    this.operationName = name;
    const operation = Promise.resolve().then(async () => {
      if (stopFirst) await this.stopOwned();
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
    this.emit('change', this.view());
    try {
      if (this.operation) await this.operation;
      await this.stopOwned();
    } catch (error) { this.closing = false; this.emit('change', this.view()); throw error; }
  }
  clientURL() { if (!this.generation) throw new Error('Game has not started'); return `${this.origin}/_runtime/${this.generation}/`; }
  runtimePaths() {
    return { binary: join(this.resources, process.platform === 'win32' ? 'openrotmg.exe' : 'openrotmg'), data: join(this.resources, 'data'), client: join(this.resources, 'client'), state: join(this.userData, 'state') };
  }
  stop(): Promise<void> {
    if (this.operation || this.closing) return Promise.reject(new Error('Another lifecycle operation is in progress'));
    return this.stopOwned();
  }
  private stopOwned(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.status === 'stopped') return Promise.resolve();
    if (this.status === 'failed' && !this.child) return Promise.reject(new Error(`The last save was not confirmed. ${this.message}`));
    this.update('stopping', 'Saving active characters and stopping server…');
    this.stopping = (async () => {
      // Start may still be validating files; do not release ownership until its promise settles.
      if (!this.child) await this.boot;
      await this.requestDrain();
      await this.boot;
      if (!this.child && this.status !== 'failed' && this.expectedStop) this.update('stopped', 'Server stopped. Save verified (exit 0).');
    })().catch(error => { this.fail(error); throw error; }).finally(() => { this.stopping = undefined; setImmediate(()=>this.emit('change',this.view())); });
    return this.stopping;
  }
}
