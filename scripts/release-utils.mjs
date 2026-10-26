import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const releaseDir = path.join(root, 'release');

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}):\n${result.stderr ?? ''}\n${result.stdout ?? ''}`);
  }
  return result.stdout;
}

export async function hashFile(file) {
  const bytes = await readFile(file);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

export async function inventory(directory, prefix = '') {
  const result = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await inventory(absolute, relative));
    else if (entry.isFile()) result[relative] = await hashFile(absolute);
    else throw new Error(`Release files must be ordinary files: ${relative}`);
  }
  return result;
}
