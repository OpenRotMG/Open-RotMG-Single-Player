import {EventEmitter} from 'node:events';
import {spawn, type ChildProcess} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {createSocket} from 'node:dgram';
import {access, chmod, mkdir, rename, rm} from 'node:fs/promises';
import {get} from 'node:https';
import {join} from 'node:path';
import {extract} from 'tar';
import {demand} from './update-format';
import {downloadPayload} from './update-network';
import type {UpdatePolicy} from './update-policy';
import {UserMessage} from './user-message';

export const HOST_PORT = 47833;
const CHECKER = 'https://openrotmg-reachability.openrotmg.workers.dev/';
const CLOUDFLARED = '2026.11.1';
const TUNNEL_ASSETS = {
  'linux-x64': {name: 'cloudflared-linux-amd64', bytes: 40346301, sha256: '97bb3b02d23a5980fc9c15a1a270e692da1923f103f920d5b16d4931d5ab55e7'},
  'win32-x64': {name: 'cloudflared-windows-amd64.exe', bytes: 55483112, sha256: '341deda3db5ec498a0482254d6c38c0b7cf01a30c37bb5dd95d2216d08955e35'},
  'darwin-arm64': {name: 'cloudflared-darwin-arm64.tgz', bytes: 19898712, sha256: '02fe4bcf08f2c09699cff30658228a739a0c47fb75f3653d1b8772a27ade4462'},
};

export type MultiplayerView = {phase: 'off' | 'home' | 'checking' | 'internet' | 'link'; home?: string; internet?: string; message: string};
type Site = {host(port: number): Promise<number>; unhost(): Promise<void>};

/** Accepts what friends paste: an address with or without http(s)://, defaulting to the hosting port. */
export function joinURL(address: string) {
  const text = address.trim(), url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !url.port) url.port = String(HOST_PORT);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) throw new UserMessage('Enter an address like 192.168.1.20:47833 or a share link.');
  return url.href;
}

/** The address of the network interface that would carry internet traffic; a UDP connect sends nothing. */
export async function homeAddress() {
  const socket = createSocket('udp4');
  try {
    await new Promise<void>((ok, bad) => { socket.once('error', bad); socket.connect(53, '8.8.8.8', ok); });
    return socket.address().address;
  } catch (error) { throw new UserMessage(`This computer is not connected to a network (${(error as Error).message}).`); }
  finally { socket.close(); }
}

/** IPv4 on purpose: the host listens on IPv4, and the checker probes whichever address the request came from. */
export function checkReachable(port: number, nonce: string): Promise<{ip: string; reachable: boolean; error?: string}> {
  return new Promise((ok, bad) => {
    const req = get(`${CHECKER}?port=${port}&nonce=${nonce}`, {family: 4, timeout: 15_000}, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return bad(new Error(`Reachability checker returned HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        try { ok(JSON.parse(body)); } catch { bad(new Error(`Reachability checker returned invalid JSON: ${body.slice(0, 200)}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Reachability checker did not answer within 15 seconds')));
    req.on('error', bad);
  });
}

export class Multiplayer extends EventEmitter {
  private state: MultiplayerView = {phase: 'off', message: ''};
  private tunnel?: ChildProcess;
  private nonce?: string;
  constructor(private site: Site, private policy: UpdatePolicy, private tools: string, private log: (message: string) => void) { super(); }
  view() { return {...this.state}; }
  reachability() { return this.nonce; }
  private set(value: MultiplayerView) { this.state = value; this.log(`Multiplayer: ${value.phase} ${value.home ?? ''} ${value.internet ?? ''} ${value.message}`); this.emit('change', this.view()); return this.view(); }
  async host() {
    demand(this.state.phase === 'off', 'Already hosting');
    const home = `http://${await homeAddress()}:${HOST_PORT}`;
    await this.site.host(HOST_PORT);
    return this.set({phase: 'home', home, message: ''});
  }
  async online() {
    demand(this.state.phase === 'home', 'Host a world before inviting friends from anywhere');
    const home = this.state.home;
    this.set({phase: 'checking', home, message: 'Checking whether friends can reach you from the internet…'});
    try {
      this.nonce = randomBytes(16).toString('hex');
      let reason: string;
      try {
        const result = await checkReachable(HOST_PORT, this.nonce);
        this.log(`Multiplayer: reachability ${JSON.stringify(result)}`);
        if (result.reachable) return this.set({phase: 'internet', home, internet: `http://${result.ip}:${HOST_PORT}`, message: 'Your router accepts connections from the internet.'});
        reason = 'Your router does not accept connections from the internet';
      } catch (error) { this.log(`Multiplayer: reachability check failed: ${(error as Error).message}`); reason = 'The reachability check is unavailable right now'; }
      this.set({phase: 'checking', home, message: `${reason}. Creating a Cloudflare share link…`});
      const link = await this.share();
      return this.set({phase: 'link', home, internet: link, message: `${reason}, so friends join through Cloudflare. The link changes each time you host.`});
    } catch (error) {
      await this.closeTunnel();
      this.set({phase: 'home', home, message: ''});
      throw error;
    } finally { this.nonce = undefined; }
  }
  async stop() {
    await this.closeTunnel();
    await this.site.unhost();
    if (this.state.phase !== 'off') this.set({phase: 'off', message: ''});
  }
  private async cloudflared() {
    const asset = TUNNEL_ASSETS[this.policy.target], folder = join(this.tools, `cloudflared-${CLOUDFLARED}`), binary = join(folder, this.policy.target === 'win32-x64' ? 'cloudflared.exe' : 'cloudflared');
    if (await access(binary).then(() => true, () => false)) return binary;
    this.set({...this.state, message: 'Downloading Cloudflare share-link tool (first time only)…'});
    const staging = `${folder}.staging`, file = join(staging, asset.name);
    await rm(staging, {recursive: true, force: true}); await mkdir(staging, {recursive: true});
    await downloadPayload({payload: {url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED}/${asset.name}`, bytes: asset.bytes, sha256: asset.sha256}}, file, this.policy, AbortSignal.timeout(this.policy.payloadDeadline));
    if (asset.name.endsWith('.tgz')) { await extract({file, cwd: staging, strict: true, filter: path => path === 'cloudflared'}); await rm(file); }
    else await rename(file, join(staging, binary.slice(folder.length + 1)));
    await chmod(join(staging, binary.slice(folder.length + 1)), 0o755);
    await rename(staging, folder);
    return binary;
  }
  private async share() {
    const binary = await this.cloudflared();
    const child = spawn(binary, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${HOST_PORT}`], {stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true});
    this.tunnel = child;
    const lines: string[] = [];
    const link = await new Promise<string>((ok, bad) => {
      const timer = setTimeout(() => bad(new Error(`Cloudflare did not create a share link within 30 seconds. Last output: ${lines.slice(-3).join(' | ')}`)), 30_000);
      child.once('error', error => { clearTimeout(timer); bad(new Error(`Could not start the share-link tool: ${error.message}`)); });
      child.once('exit', (code, signal) => {
        clearTimeout(timer); bad(new Error(`The share-link tool exited (code ${code}, signal ${signal}). Last output: ${lines.slice(-3).join(' | ')}`));
        if (this.tunnel === child) { this.tunnel = undefined; if (this.state.phase === 'link') this.set({phase: 'home', home: this.state.home, message: `The share link stopped (cloudflared exit code ${code}). Use "Let friends anywhere join" to make a new one.`}); }
      });
      child.stderr!.setEncoding('utf8');
      let found: string | undefined, registered = false;
      child.stderr!.on('data', (chunk: string) => {
        for (const line of chunk.split('\n').filter(Boolean)) { lines.push(line); lines.splice(0, lines.length - 20); this.log(`cloudflared: ${line}`); }
        found ??= /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(chunk)?.[0];
        // The name exists as soon as it is printed, but friends only reach this computer once a connection is registered.
        registered ||= chunk.includes('Registered tunnel connection');
        if (found && registered) { clearTimeout(timer); ok(found); }
      });
    });
    return link;
  }
  private async closeTunnel() {
    const child = this.tunnel; this.tunnel = undefined;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>(ok => { child.once('exit', () => ok()); child.kill(); });
  }
}
