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

test('host protocol retains duplicate result names and every positional cell', timeout, async () => {
  const database = await createMariaDB();
  try {
    const connection = await connect(database);
    const result = await execute(database, connection, "SELECT 1 AS ordering, 2 AS ordering, NULL AS ordering, X'00ff' AS ordering");
    assert.deepEqual(result.columns.map(column => column.name), ['ordering', 'ordering', 'ordering', 'ordering']);
    assert.deepEqual(result.rows[0].slice(0, 3).map(decode), ['1', '2', null]);
    assert.deepEqual(Buffer.from(result.rows[0][3], 'base64'), Buffer.from([0, 255]));
    const empty = await execute(database, connection, 'SELECT 1 AS ordering, 2 AS ordering WHERE 0');
    assert.equal(empty.columns.length, 2);
    assert.deepEqual(empty.rows, []);
  } finally {
    await database.close();
  }
});

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

test('protocol validates version, database, credentials, charset and independent sessions', timeout, async () => {
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
    const another = await connect(database);
    assert.notEqual(another, connection);
    await request(database, { op: 'close', connection: another });
    assert.equal((await request(database, { op: 'query', connection: 'wrong', sql: 'SELECT 1' })).error.sqlstate, '08003');
    const missing = await request(database, { op: 'query', connection, sql: 'SELECT * FROM missing_table' });
    assert.equal(missing.error.errno, 1146);
    assert.equal(missing.error.sqlstate, '42S02');
    assert.equal((await request(database, { op: 'close', connection })).ok, true);
    assert.equal((await request(database, { op: 'query', connection, sql: 'SELECT 1' })).error.sqlstate, '08003');
    assert.notEqual(await connect(database), connection);
  } finally { await database.close(); }
});

test('UTF-8 DSN charsets negotiate real server semantics and survive SQL overrides', timeout, async () => {
  const database = await createMariaDB();
  try {
    for (const [requested, expected] of [['utf8', 'utf8mb3'], ['utf8mb3', 'utf8mb3'], ['utf8mb4', 'utf8mb4']]) {
      const opened = await request(database, { op: 'connect', charset: requested });
      assert.equal(opened.ok, true, JSON.stringify(opened));
      const connection = opened.result.connection;
      const selected = await execute(database, connection, "SELECT @@character_set_client AS client_charset, @@character_set_connection AS connection_charset, @@character_set_results AS result_charset, 'café 中文' AS label");
      assert.deepEqual(selected.rows[0].map(decode), [expected, expected, expected, 'café 中文']);
      await execute(database, connection, 'SET NAMES latin1');
      const restored = await execute(database, connection, 'SELECT @@character_set_client AS client_charset');
      assert.equal(decode(restored.rows[0][0]), expected);
      await execute(database, connection, 'CREATE TABLE IF NOT EXISTS charset_values (label VARCHAR(50) CHARACTER SET utf8mb4)');
      await execute(database, connection, "SET SESSION sql_mode='STRICT_ALL_TABLES'");
      const supplementary = await request(database, { op: 'query', connection, sql: "INSERT INTO charset_values VALUES ('🚀')" });
      assert.equal(supplementary.ok, expected === 'utf8mb4', JSON.stringify(supplementary));
      if (!supplementary.ok) assert.match(supplementary.error.sqlstate, /^(?:22007|HY000)$/);
      assert.equal((await request(database, { op: 'close', connection })).ok, true);
    }
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
  const engine = { closeSession() { throw new Error('storage failure'); } };
  const protocol = new MariaDBProtocol(engine, 'joomla', '13.1.0');
  protocol.connections.set('leased-connection', { session: 1, charset: 'utf8mb4' });
  await assert.rejects(protocol.reset(), /storage failure/);
  assert.equal(protocol.connections.get('leased-connection').session, 1);
});

test('real sessions isolate transactions, temporary tables, variables and close ownership', timeout, async () => {
  const database = await createMariaDB();
  try {
    const first = await connect(database);
    const second = await connect(database);
    await execute(database, first, 'CREATE TABLE session_rows (id INT PRIMARY KEY) ENGINE=InnoDB');
    await execute(database, first, 'SET @owner=11');
    await execute(database, first, 'CREATE TEMPORARY TABLE private_rows (id INT)');
    await execute(database, first, 'START TRANSACTION');
    await execute(database, first, 'INSERT INTO session_rows VALUES (1)');
    assert.deepEqual((await execute(database, second, 'SELECT COUNT(*) FROM session_rows')).rows[0].map(decode), ['0']);
    assert.deepEqual((await execute(database, second, 'SELECT @owner')).rows[0], [null]);
    assert.equal((await request(database, { op: 'query', connection: second, sql: 'SELECT * FROM private_rows' })).error.errno, 1146);
    await execute(database, second, 'SET @owner=22');
    await execute(database, second, 'INSERT INTO session_rows VALUES (2)');
    await request(database, { op: 'close', connection: first });
    assert.deepEqual((await execute(database, second, 'SELECT id FROM session_rows')).rows.map(row => decode(row[0])), ['2']);
    assert.deepEqual((await execute(database, second, 'SELECT @owner')).rows[0].map(decode), ['22']);
    const reopened = await connect(database);
    assert.deepEqual((await execute(database, reopened, 'SELECT @owner')).rows[0], [null]);
    assert.deepEqual((await execute(database, reopened, 'SELECT @@max_allowed_packet, @@innodb_buffer_pool_size')).rows[0].map(decode), ['134217728', '67108864']);
  } finally { await database.close(); }
});

test('session exhaustion is recoverable and reset closes all independent sessions', timeout, async () => {
  const database = await createMariaDB();
  try {
    const sessions = [];
    for (let index = 0; index < 32; index++) sessions.push(await connect(database));
    const overflow = await request(database, { op: 'connect' });
    assert.equal(overflow.error.code, 'CONNECTION_LIMIT');
    await execute(database, sessions[0], 'CREATE TABLE reset_sessions (id INT PRIMARY KEY) ENGINE=InnoDB');
    await execute(database, sessions[0], 'INSERT INTO reset_sessions VALUES (0)');
    for (let index = 0; index < 2; index++) {
      await execute(database, sessions[index], 'SET @private=1');
      await execute(database, sessions[index], 'START TRANSACTION');
      await execute(database, sessions[index], `INSERT INTO reset_sessions VALUES (${index + 1})`);
    }
    await database.reset();
    for (const connection of sessions) assert.equal((await request(database, { op: 'query', connection, sql: 'SELECT 1' })).error.sqlstate, '08003');
    const reopened = await connect(database);
    assert.deepEqual((await execute(database, reopened, 'SELECT id FROM reset_sessions')).rows.map(row => decode(row[0])), ['0']);
    assert.deepEqual((await execute(database, reopened, 'SELECT @private')).rows[0], [null]);
  } finally { await database.close(); }
});

test('lock waits return a SQL error before the bridge deadline and preserve sessions', timeout, async () => {
  const database = await createMariaDB();
  try {
    const first = await connect(database), second = await connect(database);
    await execute(database, first, 'CREATE TABLE locked_rows (id INT PRIMARY KEY, value INT) ENGINE=InnoDB');
    await execute(database, first, 'INSERT INTO locked_rows VALUES (1, 1)');
    await execute(database, first, 'START TRANSACTION');
    await execute(database, first, 'UPDATE locked_rows SET value=2 WHERE id=1');
    const result = await request(database, { op: 'query', connection: second, sql: 'UPDATE locked_rows SET value=3 WHERE id=1' });
    assert.equal(result.error.errno, 1205);
    assert.equal(database.state, 'ready');
    await execute(database, first, 'ROLLBACK');
    await execute(database, second, 'UPDATE locked_rows SET value=3 WHERE id=1');
    assert.deepEqual((await execute(database, first, 'SELECT value FROM locked_rows')).rows[0].map(decode), ['3']);
  } finally { await database.close(); }
});

test('large values exceed the former packet and response limits without truncation', timeout, async () => {
  const database = await createMariaDB();
  try {
    const connection = await connect(database);
    await execute(database, connection, 'CREATE TABLE large_values (body LONGTEXT) ENGINE=InnoDB');
    await execute(database, connection, "INSERT INTO large_values VALUES (REPEAT('x', 17 * 1024 * 1024))");
    assert.deepEqual((await execute(database, connection, 'SELECT LENGTH(body) FROM large_values')).rows[0].map(decode), [String(17 * 1024 * 1024)]);
    const value = (await execute(database, connection, 'SELECT body FROM large_values')).rows[0][0];
    const bytes = Buffer.from(value, 'base64');
    assert.equal(bytes.length, 17 * 1024 * 1024);
    assert.equal(bytes.every(value => value === 120), true);
    assert.deepEqual((await execute(database, connection, 'SELECT 42')).rows[0].map(decode), ['42']);
  } finally { await database.close(); }
});
