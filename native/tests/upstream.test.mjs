import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { createMariaDB } from '../../src/index.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(process.env.PHP_WASM_EXTENSION_DIR || join(root, '.native-build/upstream'));
const modules = resolve(process.env.PHP_WASM_MODULE_ROOT || join(root, 'node_modules'));
const { PhpNode } = await import(pathToFileURL(join(modules, 'php-wasm/PhpNode.mjs')));
const { PhpCgiNode } = await import(pathToFileURL(join(modules, 'php-cgi-wasm/PhpCgiNode.mjs')));
const pins = JSON.parse(await readFile(new URL('../upstream-versions.json', import.meta.url), 'utf8'));
const minors = process.env.PHP_WASM_VERSIONS?.split(',') || Object.keys(pins.php);
const contract = await readFile(new URL('./database-contract.php', import.meta.url), 'utf8');
const adapter = await readFile(new URL('../../adapters/php-wasm.php', import.meta.url), 'utf8');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

for (const packageName of ['php-wasm', 'php-cgi-wasm']) {
  const pkg = JSON.parse(await readFile(join(modules, packageName, 'package.json'), 'utf8'));
  assert.equal(pkg.version, pins.runtimeVersion, `${packageName} must match the compiled extension`);
}

async function extension(minor) {
  assert.ok(pins.php[minor], `Unsupported PHP minor: ${minor}`);
  const file = `php${minor}-pdo-mariadb-wasm.so`;
  const manifest = JSON.parse(await readFile(join(output, `php${minor}-pdo-mariadb-wasm.json`), 'utf8'));
  assert.equal(manifest.upstream.runtimeVersion, pins.runtimeVersion);
  assert.equal(manifest.upstream.commit, pins.commit);
  assert.equal(manifest.phpVersion, pins.php[minor].version);
  assert.equal(manifest.emscriptenVersion, pins.emscriptenVersion);
  assert.equal(manifest.extension.file, file);
  assert.equal(manifest.extension.sha256, digest(await readFile(join(output, file))));
  for (const [source, expected] of Object.entries(manifest.nativeSources)) {
    assert.equal(expected, digest(await readFile(join(root, 'native', source))), `Rebuild stale native source: ${source}`);
  }
  return { name: file, url: pathToFileURL(join(output, file)).href, ini: true };
}

async function databaseCall(database, request) {
  const response = JSON.parse(await database.hostCalls['mariadb.v1'](JSON.stringify({ version: 1, ...request })));
  assert.equal(response.ok, true, JSON.stringify(response.error));
  return response.result;
}

for (const minor of minors) {
  test(`PHP ${minor} published runtime executes the native PDO contract`, { timeout: 120_000 }, async () => {
    const database = await createMariaDB({ database: 'joomla' });
    const operations = [];
    const php = new PhpNode({
      version: minor,
      persist: [],
      sharedLibs: [await extension(minor)],
      shared: { mariadbCall: async payload => {
        operations.push(JSON.parse(payload).op);
        return database.hostCalls['mariadb.v1'](payload);
      } },
    });
    let stdout = '';
    let stderr = '';
    php.addEventListener('output', event => { stdout += event.detail.join(''); });
    php.addEventListener('error', event => { stderr += event.detail.join(''); });
    try {
      await php.writeFile('/bridge.php', adapter);
      await php.writeFile('/contract.php', contract);
      const exitCode = await php.run(`<?php
        require '/bridge.php';
        if (PHP_VERSION !== '${pins.php[minor].version}' || !extension_loaded('pdo_mariadb_wasm')) {
          throw new RuntimeException('Native extension/runtime identity mismatch');
        }
        require '/contract.php';
      `);
      assert.equal(exitCode, 0, stderr);
      assert.equal(stderr, '');
      const result = JSON.parse(stdout);
      assert.equal(result.type, 'complete');
      assert.ok(result.assertions >= 17);
      assert.ok(operations.filter(op => op === 'query').length >= 20);
      assert.equal(operations.at(-1), 'close');
      await php.refresh();
    } finally {
      await database.close();
    }
  });

  test(`PHP ${minor} request boundary resets container-held PDO connections`, { timeout: 120_000 }, async () => {
    const database = await createMariaDB({ database: 'joomla' });
    const php = new PhpCgiNode({
      version: minor,
      persist: [],
      docroot: '/www',
      prefix: '/',
      sharedLibs: [await extension(minor)],
      ini: 'auto_prepend_file=/bridge.php\ndisplay_errors=1',
      shared: { mariadbCall: payload => database.hostCalls['mariadb.v1'](payload) },
    });
    // Framework containers can retain PDO objects beyond the useful request
    // lifetime. Explicit cleanup must work whether native destruction ran or not.
    const request = async () => {
      try {
        return await php.request({ url: '/index.php', method: 'GET', headers: { host: 'localhost' } });
      } finally {
        await database.reset();
      }
    };
    try {
      await php.mkdir('/config');
      await php.mkdir('/www');
      await php.writeFile('/bridge.php', adapter);
      await php.writeFile('/www/index.php', `<?php
        final class ApplicationContainer {
          public static ?self $instance = null;
          public PDO $database;
          public self $application;
        }
        $container = new ApplicationContainer();
        $container->application = $container;
        $container->database = new PDO('mysql:dbname=joomla', 'root', '');
        ApplicationContainer::$instance = $container;
        $container->database->exec('CREATE TABLE retained_pdo (id INT) ENGINE=InnoDB');
        $container->database->beginTransaction();
        $container->database->exec('INSERT INTO retained_pdo VALUES (1)');
        echo 'container request completed';
      `);
      const first = await request();
      assert.equal(await first.text(), 'container request completed');
      await php.writeFile('/www/index.php', `<?php
        $db = new PDO('mysql:dbname=joomla', 'root', '');
        echo $db->query('SELECT COUNT(*) AS total FROM retained_pdo')->fetchColumn();
      `);
      const second = await request();
      assert.equal(await second.text(), '0', 'Next request must reconnect after rollback');
    } finally {
      await database.close();
    }
  });

  for (const scenario of ['return', 'exit', 'fatal']) {
    test(`PHP ${minor} native CGI ${scenario} releases the PDO lease and rolls back`, { timeout: 120_000 }, async () => {
      const database = await createMariaDB({ database: 'joomla' });
      const operations = [];
      const php = new PhpCgiNode({
        version: minor,
        persist: [],
        docroot: '/www',
        prefix: '/',
        sharedLibs: [await extension(minor)],
        ini: 'auto_prepend_file=/bridge.php\ndisplay_errors=1',
        shared: { mariadbCall: async payload => {
          operations.push(JSON.parse(payload).op);
          return database.hostCalls['mariadb.v1'](payload);
        } },
      });
      try {
        await php.mkdir('/config');
        await php.mkdir('/www');
        await php.writeFile('/bridge.php', adapter);
        await php.writeFile('/www/index.php', `<?php
          $db = new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '');
          $db->exec('CREATE TABLE cleanup (id INT) ENGINE=InnoDB');
          $db->beginTransaction();
          $db->exec('INSERT INTO cleanup VALUES (1)');
          header('Content-Type: application/json');
          echo json_encode(['native' => extension_loaded('pdo_mariadb_wasm'), 'scenario' => '${scenario}']);
          ${scenario === 'exit' ? 'exit(17);' : scenario === 'fatal' ? 'bridge_intentional_undefined_function();' : ''}
        `);
        const original = await php.binary;
        const response = await php.request({ url: '/index.php', method: 'GET', headers: { host: 'localhost' } });
        const body = await response.text();
        assert.equal(response.status, 200, body);
        assert.ok(body.startsWith(JSON.stringify({ native: true, scenario })), body);
        if (scenario === 'fatal') assert.match(body, /Call to undefined function bridge_intentional_undefined_function/);
        assert.equal(operations.at(-1), 'close', `Native destructor did not release its lease: ${operations}`);
        const connection = await databaseCall(database, { op: 'connect', database: 'joomla' });
        const result = await databaseCall(database, {
          op: 'query', connection: connection.connection, sql: 'SELECT COUNT(*) AS total FROM cleanup',
        });
        assert.equal(Buffer.from(result.rows[0][0], 'base64').toString(), '0', 'Native close must roll back');
        await databaseCall(database, { op: 'close', connection: connection.connection });
        // Upstream replaces the runtime after a non-zero exit. Consumers must
        // explicitly restore application state or stop that playground session.
        assert.equal(original !== await php.binary, scenario !== 'return');
      } finally {
        await database.close();
      }
    });
  }
}
