import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashFile, inventory, releaseDir, root, run } from './release-utils.mjs';
import { prepareEngine, vendorDirectory } from './prepare-engine.mjs';

const threadingPatch = await prepareEngine();

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const engine = JSON.parse(await readFile(path.join(root, 'node_modules/lite4mariadb/package.json'), 'utf8'));
if (pkg.devDependencies.lite4mariadb !== engine.version || lock.packages['node_modules/lite4mariadb'].version !== engine.version) {
  throw new Error('Installed engine differs from the locked release dependency; run npm ci');
}
if (lock.version !== pkg.version || lock.packages[''].version !== pkg.version) throw new Error('Package version mismatch');
// This directory contains only generated release output. Remove old versions so
// a tag workflow cannot accidentally publish stale files through its globs.
await rm(releaseDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true });
const staging = await mkdtemp(path.join(tmpdir(), 'mariadb-bridge-release-'));
const bundleName = `mariadb-wasm-bridge-${pkg.version}`;
const bundle = path.join(staging, bundleName);
try {
  await mkdir(bundle);
  for (const name of ['src', 'types', 'native', 'docs', 'patches', 'README.md', 'LICENSE', 'NOTICE']) {
    await cp(path.join(root, name), path.join(bundle, name), {
      recursive: true,
      filter: source => !/(?:^|\/)(?:\.build|\.libs|\.native-build|autom4te\.cache)(?:\/|$)|\.(?:so|o|lo|la)$/.test(source),
    });
  }
  const vendor = path.join(bundle, 'vendor/lite4mariadb');
  await cp(vendorDirectory, vendor, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    bridgeVersion: pkg.version,
    protocolVersion: 1,
    sourceCommit: run('git', ['rev-parse', 'HEAD']).trim(),
    engine: {
      name: engine.name,
      version: engine.version,
      license: engine.license,
      integrity: lock.packages['node_modules/lite4mariadb'].integrity,
      threadingPatch,
    },
    phpDriver: { module: 'pdo_mariadb_wasm', pdoName: 'mysql', sourceOnly: true },
    files: await inventory(bundle),
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(bundle, 'bridge-manifest.json'), manifestText);
  await writeFile(path.join(releaseDir, 'bridge-manifest.json'), manifestText);
  const archiveName = `${bundleName}.tar.gz`;
  run('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', path.join(releaseDir, archiveName), '-C', staging, bundleName]);
  const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', releaseDir]));
  if (packed.length !== 1 || !/^[a-z0-9._-]+\.tgz$/.test(packed[0].filename)) throw new Error('Unexpected npm pack result');
  const checksums = [];
  for (const file of [archiveName, packed[0].filename, 'bridge-manifest.json'].sort()) {
    checksums.push(`${(await hashFile(path.join(releaseDir, file))).sha256}  ${file}`);
  }
  await writeFile(path.join(releaseDir, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
  console.log(`Packaged ${archiveName}, ${packed[0].filename}, manifest, and SHA256SUMS.`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
