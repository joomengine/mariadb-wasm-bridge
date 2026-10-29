import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashFile, inventory, releaseDir, root, run } from './release-utils.mjs';


export async function verifyRelease() {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const bundleName = `mariadb-wasm-bridge-${pkg.version}`;
  const archiveName = `${bundleName}.tar.gz`;
  const npmName = `joomengine-mariadb-wasm-bridge-${pkg.version}.tgz`;
  const expected = [archiveName, npmName, 'bridge-manifest.json'].sort();
  const lines = (await readFile(path.join(releaseDir, 'SHA256SUMS'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, expected.length, 'Release must checksum exactly the intended outputs');
  const names = [];
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([a-zA-Z0-9._-]+)$/.exec(line);
    assert.ok(match, 'Invalid SHA256SUMS entry');
    names.push(match[2]);
    assert.equal((await hashFile(path.join(releaseDir, match[2]))).sha256, match[1], `Checksum mismatch: ${match[2]}`);
  }
  assert.deepEqual(names.sort(), expected);
  assert.deepEqual((await readdir(releaseDir)).sort(), [...expected, 'SHA256SUMS'].sort(), 'Unexpected files in release directory');
  const manifest = JSON.parse(await readFile(path.join(releaseDir, 'bridge-manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.bridgeVersion, pkg.version);
  assert.equal(manifest.protocolVersion, 1);
  assert.equal(manifest.engine.version, pkg.devDependencies.lite4mariadb);
  assert.equal(manifest.phpDriver.sourceOnly, true);
  assert.ok(manifest.files['vendor/lite4mariadb/lite4mariadb.wasm'], 'Engine binary is missing from manifest');
  assert.ok(manifest.files['vendor/lite4mariadb/COPYING'], 'Engine license is missing from manifest');
  assert.ok(manifest.files['src/index.mjs'], 'Bridge entry point is missing from manifest');
  assert.ok(manifest.files['adapters/php-wasm.mjs'], 'Upstream JavaScript adapter is missing from manifest');
  assert.ok(manifest.files['adapters/php-wasm.php'], 'Upstream PHP transport is missing from manifest');

  const extracted = await mkdtemp(path.join(tmpdir(), 'mariadb-bridge-verify-'));
  try {
    for (const name of [archiveName, npmName]) {
      const archive = path.join(releaseDir, name);
      const prefix = name === archiveName ? bundleName : 'package';
      const entries = run('tar', ['-tzf', archive]).trim().split('\n');
      for (const entry of entries) {
        assert.ok(entry === `${prefix}/` || entry.startsWith(`${prefix}/`), 'Unexpected archive root');
        assert.ok(!entry.split('/').includes('..') && !entry.includes('\\'), 'Unsafe archive member');
        assert.ok(!/\.(?:so|o|lo|la)$/.test(entry), 'Native build output must not ship as portable driver source');
      }
      for (const line of run('tar', ['-tvzf', archive]).trim().split('\n')) {
        assert.match(line, /^[-d]/, 'Only regular files and directories may be shipped');
      }
      run('tar', ['-xzf', archive, '--no-same-owner', '--no-same-permissions', '-C', extracted]);
    }
    const bundle = path.join(extracted, bundleName);
    assert.equal(await readFile(path.join(bundle, 'bridge-manifest.json'), 'utf8'), await readFile(path.join(releaseDir, 'bridge-manifest.json'), 'utf8'));
    const files = await inventory(bundle);
    delete files['bridge-manifest.json'];
    assert.deepEqual(files, manifest.files, 'Archive files differ from the release manifest');
    const npmPackage = JSON.parse(await readFile(path.join(extracted, 'package/package.json'), 'utf8'));
    assert.equal(npmPackage.name, pkg.name);
    assert.equal(npmPackage.version, pkg.version);
    assert.equal(npmPackage.devDependencies.lite4mariadb, manifest.engine.version);
    assert.equal(npmPackage.dependencies, undefined, 'The npm runtime uses its prepared bundled engine');
    const patchRecord = JSON.parse(await readFile(path.join(bundle, 'vendor/lite4mariadb/joomengine-patches.json'), 'utf8'));
    assert.deepEqual(patchRecord, manifest.engine.threadingPatch, 'Threading patch provenance mismatch');
    const { patchedSha256 } = patchRecord;
    assert.equal(patchRecord.id, 'independent-sessions-v1');
    assert.equal(patchRecord.upstreamSourceCommit, '24be9371a2f6c71250a2356631ad6feab2280b02');
    assert.equal(patchRecord.patchSha256, (await hashFile(path.join(root, 'patches/engine/independent-sessions.patch'))).sha256);
    assert.equal(manifest.files['vendor/lite4mariadb/lite4mariadb.js'].sha256, patchedSha256);
    assert.equal(manifest.files['vendor/lite4mariadb/lite4mariadb.wasm'].sha256, patchRecord.wasmSha256, 'Built engine binary differs from its provenance');
    const npmFiles = await inventory(path.join(extracted, 'package'));
    delete npmFiles['package.json'];
    const sharedFiles = manifest.files;
    assert.deepEqual(npmFiles, sharedFiles, 'npm package must contain the same bridge, prepared engine, driver source, types, and documentation as the standalone archive');
    return { manifest, bundleName, archiveName };
  } finally {
    await rm(extracted, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { archiveName } = await verifyRelease();
  console.log(`Verified ${archiveName}, npm package, asset manifest, and checksums.`);
}
