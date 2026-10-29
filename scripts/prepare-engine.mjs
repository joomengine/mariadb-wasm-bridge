import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './release-utils.mjs';

const sourceCommit = '24be9371a2f6c71250a2356631ad6feab2280b02';
export const vendorDirectory = path.join(root, 'vendor/lite4mariadb');
const hash = value => createHash('sha256').update(value).digest('hex');

export async function prepareEngine() {
  const installed = path.join(root, 'node_modules/lite4mariadb');
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const upstream = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(pkg.devDependencies.lite4mariadb, '0.1.2');
  assert.equal(upstream.version, '0.1.2');
  assert.equal(lock.packages['node_modules/lite4mariadb'].version, upstream.version);
  const built = path.join(root, '.native-build/engine/dist');
  let provenance;
  try { provenance = JSON.parse(await readFile(path.join(built, 'joomengine-patches.json'), 'utf8')); }
  catch (cause) { throw new Error('Build the MariaDB engine first: node scripts/build-engine.mjs', { cause }); }
  assert.equal(provenance.id, 'independent-sessions-v1');
  assert.equal(provenance.upstreamSourceCommit, sourceCommit);
  assert.equal(provenance.patchSha256, hash(await readFile(path.join(root, 'patches/engine/independent-sessions.patch'))));
  assert.match(provenance.compiler, /6\.0\.6/);
  assert.equal(hash(await readFile(path.join(built, 'lite4mariadb.js'))), provenance.patchedSha256);
  assert.equal(hash(await readFile(path.join(built, 'lite4mariadb.wasm'))), provenance.wasmSha256);
  // Only generated assets live here. Never mutate the installed dependency.
  await rm(vendorDirectory, { recursive: true, force: true });
  await mkdir(vendorDirectory, { recursive: true });
  await cp(built, vendorDirectory, { recursive: true });
  await cp(path.join(installed, 'COPYING'), path.join(vendorDirectory, 'COPYING'));
  await writeFile(path.join(vendorDirectory, 'package.json'), `${JSON.stringify({ name: upstream.name, version: upstream.version, type: 'module', license: upstream.license }, null, 2)}\n`);
  await writeFile(path.join(vendorDirectory, 'joomengine-patches.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  await cp(path.join(root, 'patches/NOTICE'), path.join(vendorDirectory, 'JOOMENGINE-NOTICE'));
  return provenance;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const provenance = await prepareEngine();
  console.log(`Prepared lite4mariadb ${provenance.upstreamVersion} with independent SQL sessions and a bounded browser pthread pool.`);
}
