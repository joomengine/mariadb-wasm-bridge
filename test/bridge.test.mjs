import test from 'node:test';
import assert from 'node:assert/strict';
import { createMariaDB } from '../src/index.mjs';
import { MariaDBProtocol } from '../src/protocol.mjs';

async function request(database, payload) {
  return JSON.parse(await database.hostCalls['mariadb.v1'](JSON.stringify({ version: 1, ...payload })));
}
async function connect(database) {
  const response = await request(database, { op: 'connect' });
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.result.connection;
}
async function execute(database, connection, sql) {
  const response = await request(database, { op: 'query', connection, sql });
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.result;
}
function decode(value) {
  return value === null ? null : Buffer.from(value, 'base64').toString('utf8');
}
const timeout = { timeout: 60_000 };

test('public host-call API executes real MariaDB and preserves PHP wire values', timeout, async () => {
  const database = await createMariaDB();
  try {
    const connection = await connect(database);
    await execute(database, connection, 'CREATE TABLE host_values (id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT, amount DECIMAL(30,10), content BLOB, label VARCHAR(80), absent INT) ENGINE=InnoDB');
    const inserted = await execute(database, connection, "INSERT INTO host_values(amount, content, label) VALUES (12345678901234567890.1234567890, X'00ff80', '🐱 café')");
    assert.equal(inserted.affectedRows, '1');
    assert.equal(inserted.insertId, '1');
    const result = await execute(database, connection, 'SELECT id, amount, content, label, absent FROM host_values');
    assert.deepEqual(result.columns.map(column => column.name), ['id', 'amount', 'content', 'label', 'absent']);
    assert.deepEqual(result.rows[0].map(decode).filter((_, index) => index !== 2), ['1', '12345678901234567890.1234567890', '🐱 café', null]);
    assert.deepEqual(Buffer.from(result.rows[0][2], 'base64'), Buffer.from([0, 255, 128]));
    assert.equal(result.affectedRows, '1');
    assert.equal(result.inTransaction, false);
    await database.flush();
  } finally { await database.close(); }
});

test('protocol validates version, database, credentials, charset and exclusive leases', timeout, async () => {
  const database = await createMariaDB();
  try {
    for (const [payload, sqlstate] of [
      [{ op: 'connect', database: 'other' }, '3D000'],
      [{ op: 'connect', password: 'secret' }, '28000'],
      [{ op: 'connect', user: 'remote' }, '28000'],
      [{ op: 'connect', charset: 'latin1' }, 'HYC00'],
    ]) {
      const response = await request(database, payload);
      assert.equal(response.ok, false);
      assert.equal(response.error.sqlstate, sqlstate);
    }
    const invalid = JSON.parse(await database.hostCalls['mariadb.v1']('{'));
    assert.equal(invalid.error.code, 'INVALID_REQUEST');
    assert.equal((await request(database, { op: 'connect', version: 2 })).error.code, 'UNSUPPORTED_PROTOCOL');
    const connection = await connect(database);
    assert.equal((await request(database, { op: 'connect' })).error.sqlstate, '08004');
    assert.equal((await request(database, { op: 'query', connection: 'wrong', sql: 'SELECT 1' })).error.sqlstate, '08003');
    const missing = await request(database, { op: 'query', connection, sql: 'SELECT * FROM missing_table' });
    assert.equal(missing.error.errno, 1146);
    assert.equal(missing.error.sqlstate, '42S02');
    assert.equal((await request(database, { op: 'close', connection })).ok, true);
    assert.equal((await request(database, { op: 'query', connection, sql: 'SELECT 1' })).error.sqlstate, '08003');
    assert.notEqual(await connect(database), connection);
  } finally { await database.close(); }
});

test('reset rolls back pending work, clears the lease and retains committed data', timeout, async () => {
  const database = await createMariaDB();
  try {
    const first = await connect(database);
    await execute(database, first, 'CREATE TABLE reset_rows (id INT PRIMARY KEY) ENGINE=InnoDB');
    await execute(database, first, 'INSERT INTO reset_rows VALUES (1)');
    await execute(database, first, 'START TRANSACTION');
    assert.equal((await execute(database, first, 'INSERT INTO reset_rows VALUES (2)')).inTransaction, true);
    await database.reset();
    assert.equal((await request(database, { op: 'query', connection: first, sql: 'SELECT 1' })).error.sqlstate, '08003');
    const second = await connect(database);
    const result = await execute(database, second, 'SELECT id FROM reset_rows ORDER BY id');
    assert.deepEqual(result.rows.map(row => decode(row[0])), ['1']);
    assert.equal(result.inTransaction, false);
    assert.equal(result.insertId, '0');
  } finally { await database.close(); }
});

test('concurrent public calls retain FIFO execution and UTF-8 result encoding', timeout, async () => {
  const database = await createMariaDB();
  try {
    const connection = await connect(database);
    await execute(database, connection, 'CREATE TABLE queued_rows (id INT AUTO_INCREMENT PRIMARY KEY, label VARCHAR(80)) ENGINE=InnoDB');
    await Promise.all(['first', 'second', 'third'].map(label => execute(database, connection, `INSERT INTO queued_rows(label) VALUES ('${label}')`)));
    await execute(database, connection, 'SET NAMES latin1');
    const result = await execute(database, connection, "SELECT label, '🐱 café' AS unicode_value FROM queued_rows ORDER BY id");
    assert.deepEqual(result.rows.map(row => row.map(decode)), [['first', '🐱 café'], ['second', '🐱 café'], ['third', '🐱 café']]);
  } finally { await database.close(); }
});

test('request limits reject oversized messages without dispatching SQL', timeout, async () => {
  const database = await createMariaDB({ maxRequestBytes: 1024 });
  try {
    const connection = await connect(database);
    const oversized = await request(database, { op: 'query', connection, sql: `SELECT '${'x'.repeat(2048)}' AS oversized` });
    assert.equal(oversized.ok, false);
    assert.equal(oversized.error.code, 'REQUEST_LIMIT');
    const result = await execute(database, connection, 'SELECT 1 AS still_available');
    assert.equal(decode(result.rows[0][0]), '1');
  } finally { await database.close(); }
});

test('a query timeout terminates the worker instead of replaying unknown work', timeout, async () => {
  const database = await createMariaDB({ timeoutMs: 100 });
  try {
    const connection = await connect(database);
    const timedOut = await request(database, { op: 'query', connection, sql: 'SELECT SLEEP(2) AS waited' });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.error.code, 'TIMEOUT');
    assert.equal(database.state, 'closed');
    assert.equal((await request(database, { op: 'query', connection, sql: 'SELECT 1' })).ok, false);
  } finally { await database.close(); }
});

test('response limits report failure and a bounded queue rejects excess calls', timeout, async () => {
  const database = await createMariaDB({ maxResponseBytes: 1024, maxQueuedRequests: 1 });
  try {
    const connection = await connect(database);
    const oversized = await request(database, { op: 'query', connection, sql: "SELECT REPEAT('x', 2048) AS oversized" });
    assert.equal(oversized.ok, false);
    assert.equal(oversized.error.code, 'RESPONSE_LIMIT');
    assert.equal(decode((await execute(database, connection, 'SELECT 1 AS recovered')).rows[0][0]), '1');
    const first = request(database, { op: 'query', connection, sql: 'SELECT SLEEP(0.1) AS waited' });
    const second = request(database, { op: 'query', connection, sql: 'SELECT 2 AS excess' });
    const [accepted, rejected] = await Promise.all([first, second]);
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'QUEUE_LIMIT');
  } finally { await database.close(); }
});

test('MySQL escaped text is stable while other configured SQL modes are preserved', timeout, async () => {
  const database = await createMariaDB();
  try {
    const connection = await connect(database);
    await execute(database, connection, "SET SESSION sql_mode = 'ANSI_QUOTES,NO_BACKSLASH_ESCAPES,STRICT_TRANS_TABLES'");
    const expected = "O'Brien; C:\\tmp\\data\0\n\r\u001a";
    const escaped = expected.replace(/\\/g, '\\\\').replace(/\0/g, '\\0').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\u001a/g, '\\Z');
    const selected = await execute(database, connection, `SELECT '${escaped}' AS quoted_value`);
    assert.equal(decode(selected.rows[0][0]), expected);
    const modes = decode((await execute(database, connection, 'SELECT @@SESSION.sql_mode AS sql_mode')).rows[0][0]).split(',');
    assert.ok(modes.includes('ANSI_QUOTES'));
    assert.ok(modes.includes('STRICT_TRANS_TABLES'));
    assert.ok(!modes.includes('NO_BACKSLASH_ESCAPES'));
  } finally { await database.close(); }
});

test('close drains accepted operations and is idempotent', timeout, async () => {
  const database = await createMariaDB();
  try {
    const connection = await connect(database);
    await execute(database, connection, 'CREATE TABLE close_rows (id INT PRIMARY KEY) ENGINE=InnoDB');
    const inserted = execute(database, connection, 'INSERT INTO close_rows VALUES (1)');
    const selected = execute(database, connection, 'SELECT COUNT(*) AS count FROM close_rows');
    const closing = database.close();
    assert.equal((await inserted).affectedRows, '1');
    assert.equal(decode((await selected).rows[0][0]), '1');
    await closing;
    assert.equal(database.state, 'closed');
    await database.close();
  } finally { await database.close(); }
});

test('a reset failure retains its connection lease', async () => {
  const engine = { query() { throw new Error('storage failure'); } };
  const protocol = new MariaDBProtocol(engine, 'joomla', '13.1.0');
  protocol.connection = 'leased-connection';
  await assert.rejects(protocol.reset(), /storage failure/);
  assert.equal(protocol.connection, 'leased-connection');
});
