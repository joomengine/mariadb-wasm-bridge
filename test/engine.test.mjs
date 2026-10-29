import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { createEngine } from '../src/engine.mjs';

// Each engine belongs to a worker: the upstream server retains pthread workers
// after shutdown, and separate workers also isolate its global connection.
async function runEngine(code, dataDir = 'memory://', deadlineMs = 60_000, close = true) {
  const engineUrl = new URL('../src/engine.mjs', import.meta.url).href;
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { createEngine } = await import(workerData.engineUrl);
      let engine;
      try {
        engine = await createEngine({ dataDir: workerData.dataDir });
        const result = await (async () => { ${code} })();
        if (workerData.close) await engine.close();
        parentPort.postMessage({ result });
      } catch (error) {
        try { await engine?.close(); } catch {}
        parentPort.postMessage({ error: { message: error.message, stack: error.stack } });
      }
    })().catch(error => { throw error; });
  `, { eval: true, workerData: { engineUrl, dataDir, close } });
  let deadline;
  try {
    return await new Promise((resolve, reject) => {
      deadline = setTimeout(() => reject(new Error(`Engine worker exceeded ${deadlineMs} ms`)), deadlineMs);
      worker.once('message', ({ result, error }) => error ? reject(new Error(error.stack || error.message)) : resolve(result));
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error(`Engine worker exited before a result (${code})`)));
    });
  } finally {
    clearTimeout(deadline);
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

test('real MariaDB accepts extension-sized SQL without consuming the C stack', { timeout: 60_000 }, async () => {
  const result = await runEngine(`
    engine.query('CREATE TABLE large_sql (id INT PRIMARY KEY, body LONGTEXT, payload LONGBLOB) ENGINE=InnoDB');
    const text = 'é🐱'.repeat(180000);
    const binary = '00ff80'.repeat(44000);
    const large = "INSERT INTO large_sql VALUES (1, '" + text + "', X'" + binary + "')";
    engine.query(large);
    const value = engine.query('SELECT LENGTH(body) AS bytes, CHAR_LENGTH(body) AS characters, MD5(body) AS digest, LENGTH(payload) AS binary_bytes, HEX(SUBSTRING(payload, 1, 3)) AS prefix FROM large_sql WHERE id=1').rows;
    const row = 'x'.repeat(5000);
    const tuples = Array.from({length:200}, (_, i) => '(' + (i+2) + ", '" + row + "', NULL)");
    engine.query('INSERT INTO large_sql VALUES ' + tuples.join(','));
    let error;
    try { engine.query("INSERT INTO large_sql VALUES (1, '" + text + "', NULL)"); }
    catch (cause) { error = { errno:cause.errno, sqlstate:cause.sqlstate }; }
    return { value, error, count:engine.query('SELECT COUNT(*) AS count FROM large_sql').rows };
  `);
  assert.deepEqual(result.value, [{ bytes: '1080000', characters: '360000',
    digest: createHash('md5').update('é🐱'.repeat(180000)).digest('hex'), binary_bytes: '132000', prefix: '00FF80' }]);
  assert.deepEqual(result.error, { errno: 1062, sqlstate: '23000' });
  assert.deepEqual(result.count, [{ count: '201' }]);
});

test('heap SQL transport releases allocated input on encoding and native failures', async () => {
  for (const failure of ['allocation', 'encoding', 'query', 'result']) {
    const engineModuleUrl = 'data:text/javascript,' + encodeURIComponent(`
      export const freed = [];
      const mod = {
        lengthBytesUTF8: value => value.length,
        _malloc: () => ${failure === 'allocation' ? '0' : '1024'},
        _free: pointer => freed.push(pointer),
        stringToUTF8: () => { ${failure === 'encoding' ? 'throw new Error("Encoding failed");' : ''} },
        _l4m_query: () => { ${failure === 'query' ? 'throw new Error("Native query failed");' : 'return 0;'} },
      };
      export const Lite4MariaDB = {create: async () => ({mod, close:async()=>{}})};
    `);
    const { freed } = await import(engineModuleUrl);
    const engine = await createEngine({ engineModuleUrl });
    try {
      assert.throws(() => engine.query('SELECT 1'), failure === 'allocation'
        ? error => error.sqlstate === 'HY001' : /failed|empty result pointer/);
      assert.deepEqual(freed, failure === 'allocation' ? [] : [1024]);
    } finally { await engine.close(); }
  }
});

test('flush checkpoints before persistence and propagates either failure', async () => {
  for (const failure of ['none', 'checkpoint', 'persistence']) {
    const engineModuleUrl = 'data:text/javascript,' + encodeURIComponent(`
      export const calls = [];
      const mod = {
        lengthBytesUTF8: value => value.length, _malloc: () => 1024, _free: () => {}, _l4m_free: () => {},
        stringToUTF8: sql => calls.push(sql),
        _l4m_query: () => { ${failure === 'checkpoint' ? 'throw new Error("Checkpoint failed");' : 'return 2048;'} },
        UTF8ToString: () => JSON.stringify({ok:true, rows:[]}),
      };
      export const Lite4MariaDB = {create: async () => ({mod,
        persist: async () => {calls.push('persist'); ${failure === 'persistence' ? 'throw new Error("IndexedDB sync failed");' : ''}},
        close: async () => {},
      })};
    `);
    const { calls } = await import(engineModuleUrl);
    const engine = await createEngine({ engineModuleUrl });
    try {
      if (failure === 'none') await engine.flush();
      else await assert.rejects(engine.flush(), failure === 'checkpoint' ? /Checkpoint failed/ : /IndexedDB sync failed/);
      assert.deepEqual(calls, failure === 'checkpoint'
        ? ['SET GLOBAL innodb_log_checkpoint_now=ON']
        : ['SET GLOBAL innodb_log_checkpoint_now=ON', 'persist']);
    } finally { await engine.close(); }
  }
});

test('startup failure retains bounded native diagnostics and its original cause', async (t) => {
  const reported = [];
  t.mock.method(console, 'error', (...args) => reported.push(args.join(' ')));
  const engineModuleUrl = 'data:text/javascript,' + encodeURIComponent(`
    export const failure = Object.assign(new Error('lite4mariadb: l4m_open failed (1)'), {code:'OPEN_FAILED', errno:2000, sqlstate:'HY000'});
    export const Lite4MariaDB = {create: async options => {
      for (let i=0;i<50;i++) options.printErr('Old initialization output ' + i + 'x'.repeat(1000));
      options.printErr('InnoDB: Plugin initialization aborted with error Data structure corruption');
      throw failure;
    }};
  `);
  const { failure } = await import(engineModuleUrl);
  await assert.rejects(createEngine({ engineModuleUrl }), error => {
    assert.equal(error.cause, failure);
    assert.equal(error.code, 'OPEN_FAILED');
    assert.equal(error.errno, 2000);
    assert.equal(error.sqlstate, 'HY000');
    assert.match(error.message, /^lite4mariadb: l4m_open failed \(1\)/);
    assert.match(error.message, /InnoDB: Plugin initialization aborted with error Data structure corruption/);
    assert.doesNotMatch(error.message, /Old initialization output 0x/);
    assert.ok(error.message.length < 8300, 'A startup error must not carry an unbounded native log.');
    return true;
  });
  assert.equal(reported.length, 51, 'Capture must retain the usual native stderr output.');
});

test('startup failure without native output preserves the original error', async () => {
  const engineModuleUrl = 'data:text/javascript,' + encodeURIComponent(`
    export const failure = new Error('Asset loading failed');
    export const Lite4MariaDB = {create: async () => {throw failure;}};
  `);
  const { failure } = await import(engineModuleUrl);
  await assert.rejects(createEngine({ engineModuleUrl }), error => error === failure);
});

test('embedded NUL and use after close fail explicitly', { timeout: 60_000 }, async () => {
  const errors = await runEngine(`
    const errors = [];
    for (const sql of ['SELECT 1' + String.fromCharCode(0) + '; SELECT 2']) {
      try { engine.query(sql); } catch (error) { errors.push(error.sqlstate); }
    }
    await engine.close();
    try { engine.query('SELECT 1'); } catch (error) { errors.push(error.errno); }
    await engine.close();
    return errors;
  `);
  assert.deepEqual(errors, ['HY000', 2006]);
});

test('real MariaDB preserves duplicate column occurrences positionally', { timeout: 60_000 }, async () => {
  const result = await runEngine(`
    return engine.query("SELECT 1 AS ordering, 2 AS ordering, NULL AS ordering, X'00ff' AS ordering, 7 AS __proto__, 8 AS \u00602\u0060, 9 AS \u00601\u0060");
  `);
  assert.deepEqual(result.fields, ['ordering', 'ordering', 'ordering', 'ordering', '__proto__', '2', '1']);
  assert.deepEqual(result.rowValues, [['1', '2', null, { $h: '00ff' }, '7', '8', '9']]);
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

test('a completed flush survives worker termination without native shutdown', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mariadb-live-save-'));
  try {
    // Deliberately terminate each worker without close(): shutdown would flush
    // dirty InnoDB pages and conceal an incomplete live-save implementation.
    await runEngine(`
      engine.query('CREATE TABLE live_save (id INT PRIMARY KEY, payload BLOB) ENGINE=InnoDB');
      engine.query("INSERT INTO live_save VALUES (1, X'00ff4142')");
      await engine.flush();
      return true;
    `, directory, 60_000, false);
    const initial = await runEngine(`
      const initial = engine.query('SELECT payload FROM live_save WHERE id = 1').rows;
      engine.query("UPDATE live_save SET payload=X'80ff004243' WHERE id=1");
      await engine.flush();
      engine.query("INSERT INTO live_save VALUES (2, X'00ff')");
      await engine.flush();
      return initial;
    `, directory, 60_000, false);
    assert.deepEqual(initial, [{ payload: { $h: '00ff4142' } }]);
    const reopened = await runEngine('return engine.query(\'SELECT id, payload FROM live_save ORDER BY id\').rows;', directory);
    assert.deepEqual(reopened, [
      { id: '1', payload: { $h: '80ff004243' } },
      { id: '2', payload: { $h: '00ff' } },
    ]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a damaged saved datadir reports the native InnoDB startup diagnostic', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mariadb-startup-diagnostic-'));
  try {
    await runEngine('engine.query(\'CREATE TABLE diagnostic_fixture (id INT) ENGINE=InnoDB\'); return true;', directory);
    const systemTablespace = await open(join(directory, 'ibdata1'), 'r+');
    try { await systemTablespace.write(new Uint8Array(16 * 1024), 0, 16 * 1024, 0); }
    finally { await systemTablespace.close(); }
    await assert.rejects(runEngine('return true;', directory), error => {
      assert.match(error.message, /lite4mariadb: l4m_open failed \(1\)/);
      assert.match(error.message, /MariaDB startup diagnostics:[\s\S]*InnoDB:[\s\S]*Data structure corruption/);
      return true;
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
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

test('protocol restores session settings after successful and failed SQL changes', { timeout: 60_000 }, async () => {
  const result = await runEngine(`
    const { MariaDBProtocol } = await import(${JSON.stringify(new URL('../src/protocol.mjs', import.meta.url).href)});
    const protocol = new MariaDBProtocol(engine, 'test', 'test');
    const invoke = async payload => JSON.parse(await protocol.handle(JSON.stringify({version:1,...payload})));
    const connection = (await invoke({op:'connect'})).result.connection;
    const selected = await invoke({op:'query', connection, sql:'SELECT 42'});
    const failed = await invoke({op:'query', connection, sql:"SET SESSION character_set_client='latin1', SESSION character_set_results='unknown_charset'"});
    const recovered = await invoke({op:'query', connection, sql:'SELECT @@character_set_client, @@character_set_results'});
    await invoke({op:'query', connection, sql:"SET SESSION sql_mode='ANSI_QUOTES,NO_BACKSLASH_ESCAPES'"});
    const modes = await invoke({op:'query', connection, sql:'SELECT @@SESSION.sql_mode'});
    await protocol.reset();
    return {selected, failed, recovered, modes};
  `);
  assert.equal(result.selected.ok, true);
  assert.equal(result.failed.ok, false);
  const decode = value => Buffer.from(value, 'base64').toString('utf8');
  assert.deepEqual(result.recovered.result.rows[0].map(decode), ['utf8mb4', 'utf8mb4']);
  const modes = decode(result.modes.result.rows[0][0]).split(',');
  assert.ok(modes.includes('ANSI_QUOTES'));
  assert.ok(!modes.includes('NO_BACKSLASH_ESCAPES'));
});


test('large transactions advance redo checkpoints and preserve rollback and reopened data', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mariadb-checkpoint-'));
  const size = 10_000;
  let originalChecksum = 0n;
  let updatedChecksum = 0n;
  for (let id = 1; id <= size; id++) {
    const body = String(id).padStart(8, '0') + 'x'.repeat(240);
    originalChecksum += BigInt(crc32(body));
    updatedChecksum += BigInt(crc32('updated:' + body));
  }
  const original = { total: String(size), owners: '0', bytes: String(size * 248), checksum: String(originalChecksum) };
  const updated = { total: String(size), owners: String(size * 7), bytes: String(size * 256), checksum: String(updatedChecksum) };
  const summarySql = 'SELECT COUNT(*) AS total, SUM(COALESCE(owner,0)) AS owners, SUM(LENGTH(body)) AS bytes, SUM(CRC32(body)) AS checksum FROM checkpoint_rows';
  try {
    const result = await runEngine(`
      // Let the embedded server's initial pthread messages reach their workers.
      await new Promise(resolve => setImmediate(resolve));
      // A small redo file forces checkpoint progress within one bulk statement.
      engine.query('SET GLOBAL innodb_log_file_size=8388608');
      engine.query('CREATE TABLE checkpoint_rows (id INT PRIMARY KEY, owner INT NULL, body VARBINARY(512), KEY owner_idx(owner), KEY body_idx(body(24))) ENGINE=InnoDB');
      for (let begin = 1; begin <= ${size}; begin += 500) {
        const values = [];
        for (let id = begin; id < begin + 500; id++) {
          const body = String(id).padStart(8, '0') + 'x'.repeat(240);
          values.push("(" + id + ", NULL, '" + body + "')");
        }
        engine.query('INSERT INTO checkpoint_rows VALUES ' + values.join(','));
        await new Promise(resolve => setImmediate(resolve));
      }
      const summary = () => engine.query(${JSON.stringify(summarySql)}).rows[0];
      const checkpoint = () => engine.query("SHOW GLOBAL STATUS LIKE 'Innodb_lsn_last_checkpoint'").rows[0].Value;
      const initial = summary();
      const before = checkpoint();
      const update = "UPDATE checkpoint_rows SET owner=7, body=CONCAT('updated:',body)";
      engine.query('START TRANSACTION');
      engine.query(update);
      const pending = summary();
      engine.query('ROLLBACK');
      const rolledBack = summary();
      engine.query('START TRANSACTION');
      engine.query(update);
      engine.query('COMMIT');
      const committed = summary();
      engine.query('SET GLOBAL innodb_log_checkpoint_now=ON');
      const after = checkpoint();
      await engine.flush();
      return { initial, pending, rolledBack, committed, before, after };
    `, directory, 35_000);
    assert.deepEqual(result.initial, original);
    assert.deepEqual(result.pending, updated);
    assert.deepEqual(result.rolledBack, original);
    assert.deepEqual(result.committed, updated);
    assert.ok(BigInt(result.after) > BigInt(result.before), 'The redo checkpoint must advance through actual writes');
    const reopened = await runEngine(`return engine.query(${JSON.stringify(summarySql)}).rows[0];`, directory, 15_000);
    assert.deepEqual(reopened, updated);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
