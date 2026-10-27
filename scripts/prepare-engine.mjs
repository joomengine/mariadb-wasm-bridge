import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './release-utils.mjs';

import { enginePatch, patchEngineSource } from '../patches/browser-pthread-pool.mjs';
export { enginePatch, patchEngineSource };
export const vendorDirectory = path.join(root, 'vendor/lite4mariadb');
const hash = value => createHash('sha256').update(value).digest('hex');

export async function prepareEngine() {
  const installed = path.join(root, 'node_modules/lite4mariadb');
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const upstream = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(pkg.devDependencies.lite4mariadb, enginePatch.upstreamVersion);
  assert.equal(upstream.version, enginePatch.upstreamVersion);
  assert.equal(lock.packages['node_modules/lite4mariadb'].version, upstream.version);
  const source = await readFile(path.join(installed, 'dist', enginePatch.file), 'utf8');
  const wasm = await readFile(path.join(installed, 'dist/lite4mariadb.wasm'));
  assert.equal(hash(wasm), enginePatch.wasmSha256, 'Unexpected upstream WASM binary');
  const patched = patchEngineSource(source);
  const provenance = { ...enginePatch, patchedSha256: hash(patched) };
  // Only generated assets live here. Never mutate the installed dependency.
  await rm(vendorDirectory, { recursive: true, force: true });
  await mkdir(vendorDirectory, { recursive: true });
  await cp(path.join(installed, 'dist'), vendorDirectory, { recursive: true });
  await cp(path.join(installed, 'COPYING'), path.join(vendorDirectory, 'COPYING'));
  await writeFile(path.join(vendorDirectory, enginePatch.file), patched);
  await writeFile(path.join(vendorDirectory, 'package.json'), `${JSON.stringify({ name: upstream.name, version: upstream.version, type: 'module', license: upstream.license }, null, 2)}\n`);
  await writeFile(path.join(vendorDirectory, 'joomengine-patches.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  await cp(path.join(root, 'patches/NOTICE'), path.join(vendorDirectory, 'JOOMENGINE-NOTICE'));
  return provenance;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const provenance = await prepareEngine();
  console.log(`Prepared lite4mariadb ${provenance.upstreamVersion} with a bounded browser pthread pool; WASM unchanged.`);
}
