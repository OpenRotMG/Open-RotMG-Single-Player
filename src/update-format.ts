import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {open} from 'node:fs/promises';

export const REPOSITORY = 'OpenRotMG/Open-RotMG-Single-Player';
export const TARGETS = ['linux-x64', 'win32-x64', 'darwin-arm64'] as const;
export type Target = typeof TARGETS[number];
export const MAX_METADATA = 64 * 1024;
export function demand(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export function exact(value: unknown, keys: string, label: string): asserts value is Record<string, unknown> {
  demand(value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.split(',').sort().join(','), `Invalid ${label} fields`);
}
export const hex = (value: unknown, length = 64): value is string => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
export const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
export function decodeJson(bytes: Uint8Array, maximum = MAX_METADATA): unknown {
  demand(bytes.byteLength > 0 && bytes.byteLength <= maximum, 'Update metadata byte limit exceeded or empty');
  try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
  catch { throw new Error('Update metadata is not valid UTF-8 JSON'); }
}
export function targetName(platform: string = process.platform, arch: string = process.arch): Target {
  const value = `${platform}-${arch}`;
  demand(TARGETS.includes(value as Target), `Unsupported target: ${value}`);
  return value as Target;
}
export function launcherVersion(value: unknown): number[] {
  demand(typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value), 'Invalid launcher version');
  const parts = value.split('.').map(Number); demand(parts.every(p => integer(p, 0, 1_000_000)), 'Launcher version outside supported range'); return parts;
}
export function versionAtLeast(actual: string, minimum: string) {
  const a = launcherVersion(actual), b = launcherVersion(minimum);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}
export async function boundedFile(path:string,maximum=4*1024*1024):Promise<Buffer>{
  const file=await open(path,'r');try{const info=await file.stat();demand(info.isFile()&&info.size<=maximum,'Update record is not a bounded regular file');return await file.readFile();}finally{await file.close();}
}
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex');
}
