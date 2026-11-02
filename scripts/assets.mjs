import { createHash } from 'node:crypto';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
export const clientFiles = ['index.html','launcher.js','client.swf','draw.html','native-texture-editor.swf','spectator.html','spectator.js','spectator.swf','vendor'];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function tree(root, selected) {
  const files = {};
  async function visit(relative) {
    const path = join(root, relative), info = await lstat(path);
    if (info.isSymbolicLink()) throw Error(`Symlink is not a pinned asset: ${path}`);
    if (info.isDirectory()) for (const entry of (await readdir(path)).sort()) await visit(relative ? `${relative}/${entry}` : entry);
    else if (info.isFile()) files[relative] = sha256(await readFile(path));
    else throw Error(`Not a regular asset: ${path}`);
  }
  for (const path of selected) await visit(path);
  return { files, sha256: sha256(JSON.stringify(files)) };
}
