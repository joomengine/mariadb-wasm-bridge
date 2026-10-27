import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { releaseDir, run } from './release-utils.mjs';
import { verifyRelease } from './verify-release.mjs';

const { archiveName, bundleName } = await verifyRelease();
const extracted = await mkdtemp(path.join(tmpdir(), 'mariadb-bridge-smoke-'));
try {
  run('tar', ['-xzf', path.join(releaseDir, archiveName), '--no-same-owner', '--no-same-permissions', '-C', extracted]);
  const bundle = path.join(extracted, bundleName);
  const smoke = `
import assert from 'node:assert/strict';
import { createMariaDB } from './src/index.mjs';
import { createPhpWasmAdapter } from './adapters/php-wasm.mjs';
const db = await createMariaDB();
try {
  const adapter = createPhpWasmAdapter(db.hostCalls);
  assert.equal(typeof adapter.shared.mariadbCall, 'function');
  assert.equal(adapter.files[0].name, 'mariadb.php');
  const call = async (request) => {
    const response = JSON.parse(await db.hostCalls['mariadb.v1'](JSON.stringify({ version: 1, ...request })));
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.result;
  };
  const { connection } = await call({ op: 'connect' });
  const query = (sql) => call({ op: 'query', connection, sql });
  await query('CREATE TABLE release_check (id INT PRIMARY KEY, label VARCHAR(100)) ENGINE=InnoDB');
  await query("INSERT INTO release_check VALUES (1, 'standalone MariaDB')");
  await query('START TRANSACTION');
  await query("INSERT INTO release_check VALUES (2, 'rollback')");
  await query('ROLLBACK');
  const result = await query('SELECT id, label FROM release_check');
  assert.deepEqual(result.rows.map(row => row.map(value => value === null ? null : Buffer.from(value, 'base64').toString('utf8'))), [['1', 'standalone MariaDB']]);
  await call({ op: 'close', connection });
} finally {
  await db.close();
}
console.log('Standalone release executes real MariaDB queries without node_modules.');
`;
  await writeFile(path.join(bundle, 'smoke.mjs'), smoke);
  process.stdout.write(run(process.execPath, [path.join(bundle, 'smoke.mjs')], { cwd: bundle, timeout: 120_000 }));
  const consumer = path.join(extracted, 'npm-consumer');
  await mkdir(consumer);
  await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const npmName = archiveName.replace(/^mariadb-wasm-bridge-/, 'joomengine-mariadb-wasm-bridge-').replace(/\.tar\.gz$/, '.tgz');
  run('npm', ['install', '--ignore-scripts', '--omit=dev', '--offline', '--no-audit', '--no-fund', '--package-lock=false', path.join(releaseDir, npmName)], { cwd: consumer });
  await writeFile(path.join(consumer, 'smoke.mjs'), smoke
    .replace("from './src/index.mjs'", "from '@joomengine/mariadb-wasm-bridge'")
    .replace("from './adapters/php-wasm.mjs'", "from '@joomengine/mariadb-wasm-bridge/php-wasm'")
    .replace('Standalone release executes real MariaDB queries without node_modules.', 'Installed npm package executes real MariaDB with lifecycle scripts disabled and no upstream runtime dependency.'));
  process.stdout.write(run(process.execPath, [path.join(consumer, 'smoke.mjs')], { cwd: consumer, timeout: 120_000 }));
} finally {
  await rm(extracted, { recursive: true, force: true });
}
