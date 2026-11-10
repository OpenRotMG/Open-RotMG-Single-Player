import {createHash, createPublicKey, verify} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat, open, readdir} from 'node:fs/promises';
import {join} from 'node:path';

export const RELEASES_PAGE = 'https://github.com/OpenRotMG/Open-RotMG-Single-Player/releases';
export const REPOSITORY = 'OpenRotMG/Open-RotMG-Single-Player';
export const TARGETS = ['linux-x64', 'win32-x64', 'darwin-arm64'] as const;
export type Target = typeof TARGETS[number];
export const MAX_METADATA = 64 * 1024, MAX_PAYLOAD = 512 * 1024 * 1024, MAX_EXPANDED = 2 * 1024 * 1024 * 1024, MAX_FILES = 10_000;
export type Pins = {
  server: {repository: string; commit: string; dataSha256: string; upstream: string};
  client: {repository: string; commit: string; preparedSha256: string; upstream: string};
  ruffle: {version: string; sourceCommit: string; bundleSha256: string};
};
export type BuildIdentity = {pins: Pins; platform: string; arch: string; binarySha256: string; buildReceiptSha256: string; assetsSha256: string};
export type Manifest = {
  format: 1; releaseId: number; tag: string; version: string; sequence: number; target: Target; minLauncher: string; clientNamespace: 1;
  save: {cli: 1; read: number[]; write: 22|23; startupBackup: 1}; pins: Pins;
  payload: {id: number; name: string; url: string; bytes: number; sha256: string; expandedBytes: number; assetsSha256: string; identitySha256: string; binarySha256: string};
};
export class UpdateProblem extends Error {
  constructor(readonly kind: 'unavailable' | 'service' | 'rejected' | 'launcher' | 'recovery' | 'canceled', message: string) { super(message); this.name = 'UpdateProblem'; }
}
export function demand(condition: unknown, message: string): asserts condition {
  if (!condition) throw new UpdateProblem('rejected', message);
}
export const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export function exact(value: unknown, keys: string, label: string): asserts value is Record<string, unknown> {
  demand(value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.split(',').sort().join(','), `Invalid ${label} fields`);
}
export const hex = (value: unknown, length = 64): value is string => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
export const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
export const label = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value);
export function decodeJson(bytes: Uint8Array, maximum = MAX_METADATA): unknown {
  demand(bytes.byteLength > 0 && bytes.byteLength <= maximum, 'Runtime metadata byte limit exceeded or empty');
  try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
  catch { throw new UpdateProblem('rejected', 'Runtime metadata is not valid UTF-8 JSON'); }
}
export function validatePins(value: unknown): Pins {
  exact(value, 'server,client,ruffle', 'runtime pins');
  exact(value.server, 'repository,commit,dataSha256,upstream', 'server pins');
  exact(value.client, 'repository,commit,preparedSha256,upstream', 'client pins');
  exact(value.ruffle, 'version,sourceCommit,bundleSha256', 'Ruffle pins');
  const {server, client, ruffle} = value;
  demand(['https://github.com/OpenRotMG/Open-RotMG-Server', 'https://github.com/dginovker/Open-RotMG-Server'].includes(String(server.repository)) && server.upstream === 'https://github.com/OpenRotMG/Open-RotMG-Server', 'Untrusted server source repository');
  demand(['https://github.com/OpenRotMG/Open-RotMG-Client','https://github.com/dginovker/Open-RotMG-Client'].includes(String(client.repository)) && client.upstream === 'https://github.com/OpenRotMG/Open-RotMG-Client', 'Untrusted client source repository');
  demand(hex(server.commit, 40) && hex(client.commit, 40) && hex(ruffle.sourceCommit, 40) && hex(server.dataSha256) && hex(client.preparedSha256) && hex(ruffle.bundleSha256) && label(ruffle.version), 'Invalid immutable component identities');
  return value as unknown as Pins;
}
export function targetName(platform: string = process.platform, arch: string = process.arch): Target {
  const value = `${platform}-${arch}`;
  demand(TARGETS.includes(value as Target), `Unsupported runtime target: ${value}`);
  return value as Target;
}
export function launcherVersion(value: unknown): number[] {
  demand(typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value), 'Invalid minimum launcher version');
  const parts = value.split('.').map(Number); demand(parts.every(p => integer(p, 0, 1_000_000)), 'Launcher version outside supported range'); return parts;
}
export function versionAtLeast(actual: string, minimum: string) {
  const a = launcherVersion(actual), b = launcherVersion(minimum);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}
export function authenticateManifest(bytes:Uint8Array,signature:Uint8Array,key:string,releaseId?:number,tag?:string):Record<string,unknown>&{sequence:number;releaseId:number;tag:string}{
  demand(bytes.byteLength <= MAX_METADATA && signature.byteLength === 64, 'Invalid manifest/signature size');
  let authenticated = false;
  try { const publicKey = createPublicKey(key); authenticated = publicKey.asymmetricKeyType === 'ed25519' && verify(null, bytes, publicKey, signature); }
  catch { throw new UpdateProblem('rejected', 'Runtime manifest signing key or signature is invalid'); }
  demand(authenticated, 'Runtime manifest signature verification failed');
  const value=decodeJson(bytes) as Record<string,unknown>;
  demand(value!==null&&typeof value==='object'&&!Array.isArray(value)&&integer(value.sequence,1)&&integer(value.releaseId,1)&&label(value.tag)&&(releaseId===undefined||value.releaseId===releaseId)&&(tag===undefined||value.tag===tag),'Invalid authenticated sequence/release generation header');
  return value as Record<string,unknown>&{sequence:number;releaseId:number;tag:string};
}
export function verifyManifest(bytes: Uint8Array, signature: Uint8Array, key: string, releaseId: number | undefined, tag: string | undefined, target: Target, launcher: string, assetOrigin: string): Manifest {
  const value=authenticateManifest(bytes,signature,key,releaseId,tag);
  exact(value, 'format,releaseId,tag,version,sequence,target,minLauncher,clientNamespace,save,pins,payload', 'runtime manifest');
  demand(value.format === 1 && integer(value.releaseId,1) && label(value.tag) && (releaseId === undefined || value.releaseId === releaseId) && (tag === undefined || value.tag === tag) && label(value.version) && integer(value.sequence, 1), 'Unsupported/future or mismatched release identity');
  demand(value.target === target, 'Runtime manifest target mismatch');
  demand(value.clientNamespace===1,'Unsupported generation-qualified client namespace capability');
  exact(value.save, 'cli,read,write,startupBackup', 'save compatibility');
  demand(value.save.cli === 1 && value.save.startupBackup === 1 && saveCompatibility(value.save), 'Unsupported runtime CLI/save compatibility');
  validatePins(value.pins);
  exact(value.payload, 'id,name,url,bytes,sha256,expandedBytes,assetsSha256,identitySha256,binarySha256', 'runtime payload');
  const p = value.payload;
  demand(integer(p.id, 1) && p.name === `runtime-${target}.tar.gz` && typeof p.url === 'string' && integer(p.bytes, 1, MAX_PAYLOAD) && integer(p.expandedBytes, 1, MAX_EXPANDED) && [p.sha256,p.assetsSha256,p.identitySha256,p.binarySha256].every(v => hex(v)), 'Invalid bounded payload identity');
  demand(p.url===`${assetOrigin}/${REPOSITORY}/releases/download/${value.tag}/${p.name}`,'Signed payload URL is not the fixed trusted repository/generation asset');
  launcherVersion(value.minLauncher);
  demand(value.save.write!==23||versionAtLeast(String(value.minLauncher),'0.1.1'),'Schema23 requires minimum launcher 0.1.1');
  if (!versionAtLeast(launcher, String(value.minLauncher))) throw new UpdateProblem('launcher', `Runtime requires launcher ${value.minLauncher}; install it manually from ${RELEASES_PAGE}`);
  return value as unknown as Manifest;
}
export function portablePath(value: unknown): asserts value is string {
  demand(typeof value === 'string' && value.length > 0 && value.length <= 240 && !value.includes('\\') && !value.startsWith('/') && !value.endsWith('/'), 'Invalid raw runtime path');
  for (const part of value.split('/')) demand(/^[A-Za-z0-9_@()+,.-]+$/.test(part) && part !== '.' && part !== '..' && !part.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part), 'Unsafe or nonportable runtime path');
}
export function runtimePath(value: unknown, target: Target): asserts value is string {
  portablePath(value);
  demand(['inventory.json','build-identity.json','REVISION',target === 'win32-x64' ? 'openrotmg.exe' : 'openrotmg'].includes(value) || /^(data|client|notices)\/.+/.test(value), `Unexpected runtime entry: ${value}`);
}
export async function boundedFile(path:string,maximum=4*1024*1024):Promise<Buffer>{
  const file=await open(path,'r');try{const info=await file.stat();demand(info.isFile()&&info.size<=maximum,'Runtime record is not a bounded regular file');return await file.readFile();}finally{await file.close();}
}
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex');
}
export async function runtimeFiles(root: string, target: Target): Promise<string[]> {
  const files: string[] = [], aliases = new Map<string,string>();
  const visit = async (relative: string) => {
    const path = join(root, relative), info = await lstat(path);
    demand(!info.isSymbolicLink(), 'Runtime links are forbidden');
    if (relative) {
      portablePath(relative);
      const alias = relative.toLowerCase(); demand(!aliases.has(alias) || aliases.get(alias) === relative, 'Runtime case alias'); aliases.set(alias, relative);
    }
    if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(relative ? `${relative}/${name}` : name);
    else { demand(info.isFile(), 'Runtime contains nonregular file'); runtimePath(relative, target); files.push(relative); demand(files.length <= MAX_FILES, 'Runtime entry limit exceeded'); }
  };
  await visit('');return files;
}
export async function verifyBinary(path: string, target: Target) {
  const handle = await open(path,'r');
  try {
    const buffer = Buffer.alloc(65536), {bytesRead} = await handle.read(buffer,0,buffer.length,0);demand(bytesRead >= 64,'Native server header is truncated');
    if (target === 'linux-x64') demand(buffer.subarray(0,4).equals(Buffer.from([127,69,76,70])) && buffer[4] === 2 && buffer[5] === 1 && buffer.readUInt16LE(18) === 62,'Server is not native Linux x64 ELF');
    else if (target === 'darwin-arm64') demand(buffer.readUInt32LE(0) === 0xfeedfacf && buffer.readUInt32LE(4) === 0x0100000c,'Server is not native ARM64 Mach-O');
    else { const pe = buffer.readUInt32LE(60); demand(buffer.toString('ascii',0,2) === 'MZ' && pe + 26 <= bytesRead && buffer.toString('ascii',pe,pe+4) === 'PE\0\0' && buffer.readUInt16LE(pe+4) === 0x8664 && buffer.readUInt16LE(pe+24) === 0x20b,'Server is not native Windows x64 PE32+'); }
  } finally { await handle.close(); }
}
export function saveCompatibility(value:Record<string,unknown>){return (value.write===22&&JSON.stringify(value.read)==='[21,22]')||(value.write===23&&JSON.stringify(value.read)==='[21,22,23]');}
export async function runtimeSaveSchema(root:string):Promise<22|23>{
  const value=decodeJson(await boundedFile(join(root,'notices/runtime-capabilities.json'))) as {save:Record<string,unknown>};
  demand(value?.save&&saveCompatibility(value.save),'Runtime save schema is unsupported');return value.save.write as 22|23;
}
export async function verifyCapabilities(root:string,pins:Pins,startupBackup:0|1,clientNamespace:0|1,desktopMetadata?:0|1):Promise<void>{
  const path=join(root,'notices','runtime-capabilities.json');
  try{await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'&&startupBackup===0&&clientNamespace===0&&desktopMetadata!==1)return;throw error;}
  const value=decodeJson(await boundedFile(path,MAX_METADATA));exact(value,value&&typeof value==='object'&&'desktopMetadata' in value?'format,server,clientNamespace,save,desktopMetadata':'format,server,clientNamespace,save','runtime capability notice');
  if('desktopMetadata' in value)demand(value.desktopMetadata===0||value.desktopMetadata===1,'Invalid bundled metadata capability');if(desktopMetadata!==undefined)demand(value.desktopMetadata===desktopMetadata,'Bundled runtime lacks required desktopMetadata capability');exact(value.save,'cli,read,write,startupBackup','runtime capability save protocol');
  demand(value.format===1&&value.server===pins.server.commit&&value.clientNamespace===clientNamespace&&value.save.cli===1&&saveCompatibility(value.save)&&value.save.startupBackup===startupBackup,'Declared runtime capabilities differ from authenticated/explicit baseline contract');
}
export async function verifyRuntime(root: string, target: Target, expected?: Manifest): Promise<BuildIdentity> {
  const files = await runtimeFiles(root,target), inventory = decodeJson(await boundedFile(join(root,'inventory.json')), 4 * 1024 * 1024);
  exact(inventory,'files,sha256','runtime inventory');
  demand(Array.isArray(inventory.files) && inventory.files.length > 0 && inventory.files.length <= MAX_FILES && new Set(inventory.files).size === inventory.files.length, 'Invalid runtime inventory list');
  demand(inventory.sha256 !== null && typeof inventory.sha256 === 'object' && !Array.isArray(inventory.sha256), 'Invalid runtime inventory hashes');
  const hashes = inventory.sha256 as Record<string,unknown>;
  demand(JSON.stringify(Object.keys(hashes)) === JSON.stringify(inventory.files), 'Inventory paths and hashes disagree');
  demand(JSON.stringify([...inventory.files,'inventory.json','build-identity.json'].sort()) === JSON.stringify([...files].sort()), 'Runtime inventory is incomplete or contains extra files');
  for (const path of inventory.files) { runtimePath(path,target);demand(hex(hashes[path]) && await hashFile(join(root,path)) === hashes[path], `Runtime file digest mismatch: ${path}`); }
  const dataHashes = Object.fromEntries(files.filter(path=>path.startsWith('data/')).map(path=>[path,hashes[path]]));
  const clientRoots = ['index.html','launcher.js','client.swf','draw.html','native-texture-editor.swf','spectator.html','spectator.js','spectator.swf','vendor'];
  const clientHashes = Object.fromEntries(clientRoots.flatMap(root=>files.filter(path=>path===`client/${root}`||path.startsWith(`client/${root}/`)).map(path=>[path.slice(7),hashes[path]])));
  const identityBytes = await boundedFile(join(root,'build-identity.json'),MAX_METADATA), identity = decodeJson(identityBytes);
  exact(identity,'pins,platform,arch,binarySha256,buildReceiptSha256,assetsSha256','runtime build identity');validatePins(identity.pins);
  demand(`${identity.platform}-${identity.arch}` === target && hex(identity.binarySha256) && hex(identity.buildReceiptSha256) && identity.assetsSha256 === digest(JSON.stringify(hashes)), 'Runtime build/inventory identity mismatch');
  demand((identity.pins as Pins).server.dataSha256 === digest(JSON.stringify(dataHashes)) && (identity.pins as Pins).client.preparedSha256 === digest(JSON.stringify(clientHashes)),'Declared data/prepared-client pins differ from actual runtime bytes');
  const lock = decodeJson(await boundedFile(join(root,'notices','ruffle-lock.json'),MAX_METADATA)) as {version:string;sourceCommit:string;bundleSha256:string};
  const ruffle=(identity.pins as Pins).ruffle;
  demand(lock.version===ruffle.version && lock.sourceCommit===ruffle.sourceCommit && lock.bundleSha256===ruffle.bundleSha256 && files.some(path=>path.startsWith('client/vendor/')&&path.endsWith('.wasm')),'Ruffle provenance/WASM differs from pinned runtime');
  const binary = target === 'win32-x64' ? 'openrotmg.exe' : 'openrotmg';
  demand(hashes[binary] === identity.binarySha256 && (await boundedFile(join(root,'REVISION'),41)).toString('utf8').trim() === (identity.pins as Pins).server.commit,'Native server/revision identity mismatch');
  await verifyBinary(join(root,binary),target);
  if(expected){await verifyCapabilities(root,expected.pins,1,1);demand(await runtimeSaveSchema(root)===expected.save.write,'Signed save schema differs from the runtime capability notice');}
  if (expected) demand(identity.assetsSha256 === expected.payload.assetsSha256 && identity.binarySha256 === expected.payload.binarySha256 && digest(identityBytes) === expected.payload.identitySha256 && JSON.stringify(identity.pins) === JSON.stringify(expected.pins),'Signed pair differs from extracted runtime');
  return identity as unknown as BuildIdentity;
}
