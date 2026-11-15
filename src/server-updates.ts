import {EventEmitter} from 'node:events';
import {createPublicKey, randomUUID, verify} from 'node:crypto';
import {access, mkdir, readdir, rename, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {extract} from 'tar';
import {REPOSITORY, Target, decodeJson, demand, exact, hex, integer, launcherVersion, versionAtLeast} from './update-format';
import {UpdatePolicy} from './update-policy';
import {downloadPayload, metadata} from './update-network';
import {fetchReleases} from './launcher-updates';
import {UpdateProgress, UpdateReporter, progressText} from './update-progress';
import type {Runtime} from './runtime';

export const SERVER_DOMAIN = Buffer.from('OpenRotMG server manifest v1\0');
export type ServerManifest = {format: 1; kind: 'openrotmg-server'; version: string; target: Target; minLauncher: string; payload: {name: string; url: string; bytes: number; sha256: string}};
export type ServerUpdateView = {installed: string; available?: string; phase: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'error'; message: string; progress?: UpdateProgress};
export const serverAssetURL = (version: string, name: string) => `https://github.com/${REPOSITORY}/releases/download/v${version}/${name}`;

export function authenticateServer(bytes: Buffer, signature: Buffer, key: string, target: Target): ServerManifest {
  demand(bytes.length <= 64 * 1024 && signature.length === 64 && verify(null, Buffer.concat([SERVER_DOMAIN, bytes]), createPublicKey(key), signature), 'Server update signature is invalid');
  const m = decodeJson(bytes) as ServerManifest;
  exact(m, 'format,kind,version,target,minLauncher,payload', 'server manifest'); exact(m.payload, 'name,url,bytes,sha256', 'server payload');
  launcherVersion(m.version); launcherVersion(m.minLauncher);
  demand(m.format === 1 && m.kind === 'openrotmg-server' && m.target === target && m.payload.name === `server-${target}.tar.gz` && m.payload.url === serverAssetURL(m.version, m.payload.name) && integer(m.payload.bytes, 1, 1024 ** 3) && hex(m.payload.sha256), 'Invalid server manifest');
  return m;
}

/** The newest of the bundled server and downloaded servers runs, so a launcher update never falls back to an older download. */
export async function newestServer(bundled: string, appVersion: string, storage: string) {
  let best = {version: appVersion, root: bundled};
  const folder = join(storage, 'servers');
  for (const name of await readdir(folder).catch(error => { if (error.code === 'ENOENT') return [] as string[]; throw error; }))
    if (/^\d+\.\d+\.\d+$/.test(name) && name !== best.version && versionAtLeast(name, best.version)) best = {version: name, root: join(folder, name)};
  return best;
}

export class ServerUpdates extends EventEmitter {
  private state: ServerUpdateView;
  private manifest?: ServerManifest;
  private reporter = new UpdateReporter(value => { this.state.progress = value; this.state.message = progressText(value); this.changed(); }, message => this.emit('log', message));
  constructor(private runtime: Runtime, private policy: UpdatePolicy, private storage: string, installed: string) {
    super(); this.state = {installed, phase: 'idle', message: ''};
  }
  view() { return {...this.state}; }
  private changed() { this.emit('change', this.view()); }
  private set(value: Partial<ServerUpdateView>) { this.state = {...this.state, progress: undefined, ...value}; this.changed(); return this.view(); }
  async check() {
    demand(!['checking', 'downloading'].includes(this.state.phase), 'A server update is already running');
    this.set({phase: 'checking', message: 'Checking…'});
    try {
      const signal = AbortSignal.timeout(20_000), target = this.policy.target;
      let latest: string | undefined;
      for (const release of await fetchReleases(this.policy.request, signal)) {
        const version = /^v(\d+\.\d+\.\d+)$/.exec(release?.tag_name ?? '')?.[1];
        if (!release.draft && !release.prerelease && version && release.assets?.some((a: {name: string}) => a.name === `server-${target}.json`) && (!latest || versionAtLeast(version, latest))) latest = version;
      }
      if (!latest || latest === this.state.installed || !versionAtLeast(latest, this.state.installed)) return this.set({phase: 'current', message: 'Up to date.', available: latest});
      const [bytes, signature] = await Promise.all(['json', 'json.sig'].map(suffix => metadata(serverAssetURL(latest!, `server-${target}.${suffix}`), this.policy, signal)));
      const manifest = authenticateServer(bytes, signature, this.policy.publicKey, target);
      demand(manifest.version === latest, 'Server manifest version differs from its release');
      if (!versionAtLeast(this.policy.launcher, manifest.minLauncher)) return this.set({phase: 'error', message: `Server ${latest} needs launcher ${manifest.minLauncher}. Update the launcher first.`, available: latest});
      this.manifest = manifest;
      return this.set({phase: 'available', message: `Server + client ${latest} is available.`, available: latest});
    } catch (error) { return this.set({phase: 'error', message: `Server update check failed: ${String(error)}`}); }
  }
  async install() {
    const manifest = this.manifest; demand(manifest && this.state.phase === 'available', 'Check for a server update first');
    this.reporter.reset(); this.set({phase: 'downloading', message: 'Downloading…'});
    const folder = join(this.storage, 'servers'), staging = join(folder, '.staging-' + randomUUID()), archive = staging + '.tar.gz', root = join(folder, manifest.version);
    try {
      await mkdir(folder, {recursive: true});
      for (const name of await readdir(folder)) if (name.startsWith('.staging-')) await rm(join(folder, name), {recursive: true, force: true});
      await mkdir(staging, {recursive: true});
      await downloadPayload(manifest, archive, this.policy, AbortSignal.timeout(this.policy.payloadDeadline), bytes => this.reporter.report('Downloading server and client', bytes, manifest.payload.bytes, 'bytes'));
      this.reporter.report('Unpacking');
      await extract({file: archive, cwd: staging, strict: true, filter: (_path, entry) => ['File', 'Directory'].includes((entry as {type: string}).type)});
      await access(join(staging, 'build-identity.json'));
      await rm(root, {recursive: true, force: true}); await rename(staging, root);
      await this.runtime.stoppedOperation('Switch server', async () => {
        this.runtime.select(root);
        for (const name of await readdir(folder)) if (name !== manifest.version && !name.startsWith('.')) await rm(join(folder, name), {recursive: true});
      });
      this.manifest = undefined;
      return this.set({installed: manifest.version, phase: 'current', message: `Server + client ${manifest.version} installed.`});
    } catch (error) { this.set({phase: 'error', message: `Server update failed: ${String(error)}`}); throw error; }
    finally { await rm(archive, {force: true}); await rm(staging, {recursive: true, force: true}); }
  }
}
