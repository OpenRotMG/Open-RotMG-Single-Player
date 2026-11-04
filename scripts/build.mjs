import { cp, mkdir, readFile, writeFile, rm, chmod, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { tree, clientFiles, sha256 } from './assets.mjs';

const pins = JSON.parse(await readFile('source-pins.json', 'utf8'));
assert(process.env.OPENROTMG_BUILD_INPUTS && isAbsolute(process.env.OPENROTMG_BUILD_INPUTS), 'Set OPENROTMG_BUILD_INPUTS to an absolute explicit build-input JSON (see README)');
const input = JSON.parse(await readFile(process.env.OPENROTMG_BUILD_INPUTS, 'utf8'));
for (const key of ['serverSource','serverBinary','clientSource','preparedClient','serverBuildReceipt']) assert(isAbsolute(input[key]), `Absolute ${key} required`);
for (const [path, expected] of [[input.serverSource, pins.server.commit], [input.clientSource, pins.client.commit]]) {
  const git = (...args) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' }).trim();
  assert.equal(git('rev-parse', 'HEAD'), expected, 'Source HEAD differs from frozen pin');
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'Tracked source must be clean');
}
assert.equal(input.platform, process.platform, 'Build input must be native platform');
assert.equal(input.arch, process.arch, 'Build input must be native architecture');
assert(/^[0-9a-f]{64}$/.test(input.serverBinarySha256), 'Explicit binary SHA256 required');
assert(!(await lstat(input.serverBinary)).isSymbolicLink(), 'Binary must be regular, not symlink');
assert.equal(sha256(await readFile(input.serverBinary)), input.serverBinarySha256, 'Compiled binary identity mismatch');
const receipt = JSON.parse(await readFile(input.serverBuildReceipt, 'utf8'));
assert.equal(receipt.head, pins.server.commit, 'Build receipt source must match frozen pin');
assert.equal(receipt.dirty, false, 'Build receipt must be from clean committed source');
assert.equal(receipt.sha256, input.serverBinarySha256, 'Build receipt must identify this exact binary');
const data = await tree(input.serverSource, ['data']);
assert.equal(data.sha256, pins.server.dataSha256, 'Runtime data identity mismatch');
const client = await tree(input.preparedClient, clientFiles);
assert.equal(client.sha256, pins.client.preparedSha256, 'Prepared client identity mismatch');
for (const name of clientFiles.filter(name => name !== 'vendor' && name !== 'native-texture-editor.swf')) {
  assert.equal(sha256(await readFile(join(input.clientSource, name))), client.files[name], `Prepared client source differs: ${name}`);
}
const lock = JSON.parse(await readFile(join(input.clientSource, 'ruffle/lock.json'), 'utf8'));
assert.equal(lock.version, pins.ruffle.version); assert.equal(lock.bundleSha256, pins.ruffle.bundleSha256);
assert(Object.keys(client.files).some(name => name.endsWith('.wasm')), 'Bundled Ruffle WASM is required');
await rm('runtime', { recursive: true, force: true });
await mkdir('runtime/client', { recursive: true });
await cp(join(input.serverSource, 'data'), 'runtime/data', { recursive: true });
for (const file of clientFiles) await cp(join(input.preparedClient, file), join('runtime/client', file), { recursive: true });
const binary = process.platform === 'win32' ? 'openrotmg.exe' : 'openrotmg';
await cp(input.serverBinary, `runtime/${binary}`); await chmod(`runtime/${binary}`, 0o755);
await writeFile('runtime/REVISION', pins.server.commit + '\n');
await mkdir('runtime/notices', { recursive: true });
await cp(join(input.serverSource, 'LICENSE'), 'runtime/notices/SERVER-AGPL-3.0');
await cp(join(input.clientSource, 'LICENSE'), 'runtime/notices/CLIENT-GPL-3.0');
await cp(join(input.clientSource, 'ruffle/lock.json'), 'runtime/notices/ruffle-lock.json');
for (const name of Object.keys(client.files).filter(name => /license|notice|copying/i.test(name))) await cp(join(input.preparedClient, name), join('runtime/notices', name.replaceAll('/', '-')));
for (const file of ['NOTICES.md', 'source-pins.json', 'LICENSE']) await cp(file, join('runtime/notices', file));
const packaged = await tree(resolve('runtime'), ['data','client','notices',binary,'REVISION']);
await writeFile('runtime/inventory.json', JSON.stringify({ files: Object.keys(packaged.files), sha256: packaged.files }, null, 2));
await writeFile('runtime/build-identity.json', JSON.stringify({ pins, platform: process.platform, arch: process.arch, binarySha256: input.serverBinarySha256, buildReceiptSha256: sha256(await readFile(input.serverBuildReceipt)), assetsSha256: packaged.sha256 }, null, 2));
await cp('.qa/renderer/renderer.js', 'dist/renderer.js');
for (const file of ['index.html', 'style.css']) await cp(`src/${file}`, `dist/${file}`);
console.log(`Prepared native runtime ${process.platform}/${process.arch}; ${Object.keys(packaged.files).length} verified files`);
