import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

// Each engine belongs to a worker: the upstream server retains pthread workers
// after shutdown, and separate workers also isolate its global connection.
async function runEngine(code, dataDir = 'memory://') {
  const engineUrl = new URL('../src/engine.mjs', import.meta.url).href;
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { createEngine } = await import(workerData.engineUrl);
      let engine;
      try {
        engine = await createEngine({ dataDir: workerData.dataDir });
        const result = await (async () => { ${code} })();
        await engine.close();
        parentPort.postMessage({ result });
      } catch (error) {
        try { await engine?.close(); } catch {}
        parentPort.postMessage({ error: { message: error.message, stack: error.stack } });
      }
    })().catch(error => { throw error; });
  `, { eval: true, workerData: { engineUrl, dataDir } });
  try {
    return await new Promise((resolve, reject) => {
      worker.once('message', ({ result, error }) => error ? reject(new Error(error.stack || error.message)) : resolve(result));
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error(`Engine worker exited before a result (${code})`)));
    });
  } finally {
    await worker.terminate();
  }
}

test('real MariaDB preserves exact wire values, binary data and metadata', { timeout: 60_000 }, async () => {
  const result = await runEngine(`
    engine.query('CREATE TABLE wire_values (id BIGINT UNSIGNED PRIMARY KEY, amount DECIMAL(30,10), payload BLOB, label VARCHAR(80), absent INT) ENGINE=InnoDB');
    engine.query("INSERT INTO wire_values VALUES (18446744073709551615, 12345678901234567890.1234567890, X'00ff8041', '🐱 café', NULL)");
    return engine.query('SELECT id, amount, payload, label, absent FROM wire_values');
  `);
  assert.deepEqual(result.fields, ['id', 'amount', 'payload', 'label', 'absent']);
  assert.equal(result.types.length, 5);
  assert.deepEqual(result.rows, [{
    id: '18446744073709551615',
    amount: '12345678901234567890.1234567890',
    payload: { $h: '00ff8041' },
    label: '🐱 café',
    absent: null,
  }]);
});

test('real MariaDB supports rollback and reports server errors', { timeout: 60_000 }, async () => {
  const result = await runEngine(`
    engine.query('CREATE TABLE transactions (id INT PRIMARY KEY) ENGINE=InnoDB');
    engine.query('START TRANSACTION');
    engine.query('INSERT INTO transactions VALUES (1)');
    engine.query('ROLLBACK');
    const rows = engine.query('SELECT COUNT(*) AS count FROM transactions').rows;
    let sqlError;
    try { engine.query('SELECT * FROM missing_table'); } catch (error) {
      sqlError = { errno: error.errno, sqlstate: error.sqlstate };
    }
    return { rows, sqlError };
  `);
  assert.deepEqual(result.rows, [{ count: '0' }]);
  assert.deepEqual(result.sqlError, { errno: 1146, sqlstate: '42S02' });
});

test('duplicate columns, embedded NUL and use after close fail explicitly', { timeout: 60_000 }, async () => {
  const errors = await runEngine(`
    const errors = [];
    for (const sql of ['SELECT 1 AS a, 2 AS a', 'SELECT 1' + String.fromCharCode(0) + '; SELECT 2']) {
      try { engine.query(sql); } catch (error) { errors.push(error.sqlstate); }
    }
    await engine.close();
    try { engine.query('SELECT 1'); } catch (error) { errors.push(error.errno); }
    await engine.close();
    return errors;
  `);
  assert.deepEqual(errors, ['HYC00', 'HY000', 2006]);
});

test('scripts fail before execution, including executable comments and mode ambiguity', { timeout: 60_000 }, async () => {
  const result = await runEngine(`
    engine.query('CREATE TABLE guarded (id INT PRIMARY KEY) ENGINE=InnoDB');
    const errors = [];
    for (const sql of [
      'INSERT INTO guarded VALUES (1); INSERT INTO guarded VALUES (2)',
      '/*! INSERT INTO guarded VALUES (1); INSERT INTO guarded VALUES (2) */',
      '/*M! INSERT INTO guarded VALUES (1); INSERT INTO guarded VALUES (2) */',
      'SELECT 1; /*! SELECT 2 */',
      "SELECT '" + String.fromCharCode(92) + "'; INSERT INTO guarded VALUES (1); -- '",
    ]) {
      try { engine.query(sql); } catch (error) { errors.push(error.code); }
    }
    const valid = engine.query("SELECT ';' AS delimiter_value, 3 AS number_value; -- trailing comment").rows;
    return { errors, valid, count: engine.query('SELECT COUNT(*) AS count FROM guarded').rows };
  `);
  assert.deepEqual(result.errors, Array(5).fill('MULTIPLE_STATEMENTS'));
  assert.deepEqual(result.valid, [{ delimiter_value: ';', number_value: '3' }]);
  assert.deepEqual(result.count, [{ count: '0' }]);
});

test('real MariaDB files reopen with committed data', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mariadb-bridge-'));
  try {
    await runEngine(`
      engine.query('CREATE TABLE persisted (id INT PRIMARY KEY, value VARCHAR(80)) ENGINE=InnoDB');
      engine.query("INSERT INTO persisted VALUES (1, 'survives reopening')");
      await engine.flush();
      return true;
    `, directory);
    const result = await runEngine("return engine.query('SELECT value FROM persisted WHERE id = 1').rows;", directory);
    assert.deepEqual(result, [{ value: 'survives reopening' }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('binary types omitted by the upstream serializer require explicit SQL casts', { timeout: 60_000 }, async () => {
  const result = await runEngine(`
    engine.query('CREATE TABLE unsupported_binary (bits BIT(8))');
    engine.query("INSERT INTO unsupported_binary VALUES (b'10000000')");
    const errors = [];
    for (const sql of ['SELECT bits FROM unsupported_binary', "SELECT ST_GeomFromText('POINT(1 2)') AS shape"]) {
      try { engine.query(sql); } catch (error) { errors.push(error.code); }
    }
    return { errors, rows: engine.query('SELECT CAST(bits AS UNSIGNED) AS bits FROM unsupported_binary').rows };
  `);
  assert.deepEqual(result.errors, ['UNSUPPORTED_RESULT', 'UNSUPPORTED_RESULT']);
  assert.deepEqual(result.rows, [{ bits: '128' }]);
});
