import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as playwright from 'playwright';
import { installHelpers, serve } from './browser-helpers.mjs';

const browsers = (process.env.BRIDGE_BROWSERS ?? 'chromium').split(',').map(name => name.trim()).filter(Boolean);
assert.ok(browsers.length > 0, 'BRIDGE_BROWSERS must select at least one real browser');
const text = value => value === null ? null : Buffer.from(value, 'base64').toString('utf8');

for (const browserName of browsers) {
  test(`${browserName}: real MariaDB WASM in a dedicated browser worker`, { timeout: 300_000 }, async t => {
    assert.ok(['chromium', 'firefox', 'webkit'].includes(browserName), `Unknown browser ${browserName}`);
    const server = await serve();
    let browser;
    let context;
    t.after(async () => {
      try { await context?.close(); }
      finally {
        try { await browser?.close(); }
        finally { await server.close(); }
      }
    });
    const executablePath = process.env[`BRIDGE_${browserName.toUpperCase()}_EXECUTABLE`];
    browser = await playwright[browserName].launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      ...(browserName === 'chromium' ? { args: ['--no-sandbox'] } : {}),
    });
    context = await browser.newContext();
    const page = await context.newPage();
    const uncaught = [];
    page.on('pageerror', error => uncaught.push(error.message));
    await installHelpers(page);
    await page.goto(server.url);
    const options = {
      database: 'joomla',
      engineModuleUrl: new URL('vendor/lite4mariadb/index.mjs', server.url).href,
      startupTimeoutMs: 120_000,
    };

    await t.test('repeated immediate memory-only shutdown completes with bounded browser pthreads', async () => {
      // The previous engine could exhaust its 16 preloaded pthreads during
      // native shutdown, then deadlock waiting for a newly created browser
      // Worker that needed the blocked creator to return to its event loop.
      for (let attempt = 0; attempt < 12; attempt++) {
        const result = await page.evaluate(async options => {
          const api = window.bridgeTest;
          await api.open(options);
          const result = await api.query('SELECT 42 AS answer');
          await api.close();
          return result;
        }, options);
        assert.equal(text(result.rows[0][0]), '42', `Immediate close iteration ${attempt + 1}`);
      }
    });

    await t.test('SQL preserves binary, Unicode, decimal, large integer and null values', async () => {
      const result = await page.evaluate(async options => {
        const api = window.bridgeTest;
        await api.open(options);
        try {
          await api.query('CREATE TABLE fixture (id INT AUTO_INCREMENT PRIMARY KEY, label VARCHAR(100), bytes BLOB, exact_value DECIMAL(30,10), large_value BIGINT UNSIGNED, absent TEXT) ENGINE=InnoDB');
          const inserted = await api.query("INSERT INTO fixture (label, bytes, exact_value, large_value, absent) VALUES (CONVERT(X'4a6f6f6d6c6120f09f8c8d' USING utf8mb4), X'0041ff807f', 12345678901234567890.1234567890, 18446744073709551615, NULL)");
          const selected = await api.query('SELECT id, label, bytes, exact_value, large_value, absent FROM fixture');
          const invalid = await api.call({ op: 'query', connection: api.connection, sql: 'SELECT FROM broken' });
          const recovered = await api.query('SELECT COUNT(*) AS total FROM fixture');
          await api.query('START TRANSACTION');
          await api.query("INSERT INTO fixture (label) VALUES ('rolled back')");
          const transaction = await api.query('SELECT COUNT(*) AS total FROM fixture');
          await api.query('ROLLBACK');
          const rolledBack = await api.query('SELECT COUNT(*) AS total FROM fixture');
          await api.query('START TRANSACTION');
          await api.query("INSERT INTO fixture (label) VALUES ('abandoned connection')");
          await api.disconnect();
          await api.connect();
          const reconnected = await api.query('SELECT COUNT(*) AS total FROM fixture');
          return { isolated: crossOriginIsolated, serverVersion: api.db.serverVersion, inserted, selected, invalid, recovered, transaction, rolledBack, reconnected };
        } finally { await api.close(); }
      }, options);
      assert.equal(result.isolated, true);
      assert.match(result.serverVersion, /MariaDB/i);
      assert.equal(result.inserted.affectedRows, '1');
      assert.equal(result.inserted.insertId, '1');
      assert.deepEqual(result.selected.columns.map(column => column.name), ['id', 'label', 'bytes', 'exact_value', 'large_value', 'absent']);
      const [row] = result.selected.rows;
      assert.equal(text(row[0]), '1');
      assert.equal(text(row[1]), 'Joomla 🌍');
      assert.deepEqual([...Buffer.from(row[2], 'base64')], [0, 65, 255, 128, 127]);
      assert.equal(text(row[3]), '12345678901234567890.1234567890');
      assert.equal(text(row[4]), '18446744073709551615');
      assert.equal(row[5], null);
      assert.equal(result.invalid.ok, false);
      assert.equal(result.invalid.error.sqlstate, '42000');
      assert.equal(result.invalid.error.errno, 1064);
      assert.equal(text(result.recovered.rows[0][0]), '1');
      assert.equal(result.transaction.inTransaction, true);
      assert.equal(text(result.transaction.rows[0][0]), '2');
      assert.equal(result.rolledBack.inTransaction, false);
      assert.equal(text(result.rolledBack.rows[0][0]), '1');
      assert.equal(text(result.reconnected.rows[0][0]), '1', 'Closing a PDO lease must roll back its uncommitted transaction');
    });

    await t.test('IndexedDB restores committed data after close and a page reload', async () => {
      const persistent = { ...options, persistence: { key: `reload-${randomUUID()}` } };
      await page.evaluate(async options => {
        const api = window.bridgeTest;
        await api.open(options);
        try {
          await api.query('CREATE TABLE saved (id INT PRIMARY KEY, payload BLOB) ENGINE=InnoDB');
          await api.query("INSERT INTO saved VALUES (7, X'00ff4142')");
          await api.db.flush();
        } finally { await api.close(); }
      }, persistent);
      await page.reload();
      const result = await page.evaluate(async options => {
        const api = window.bridgeTest;
        await api.open(options);
        try { return await api.query('SELECT id, payload FROM saved'); }
        finally { await api.close(); }
      }, persistent);
      assert.equal(text(result.rows[0][0]), '7');
      assert.deepEqual([...Buffer.from(result.rows[0][1], 'base64')], [0, 255, 65, 66]);
    });

    await t.test('two tabs cannot write the same database and close releases its lock', async () => {
      const persistent = { ...options, persistence: { key: `lock-${randomUUID()}` } };
      const contender = await context.newPage();
      await installHelpers(contender);
      try {
        await page.evaluate(async options => {
          const api = window.bridgeTest;
          await api.open(options);
          await api.query('CREATE TABLE owned (id INT PRIMARY KEY) ENGINE=InnoDB');
          await api.query('INSERT INTO owned VALUES (42)');
          await api.db.flush();
        }, persistent);
        await contender.goto(server.url);
        const code = await contender.evaluate(async options => {
          const { createMariaDB } = await import('/src/index.mjs');
          try {
            const db = await createMariaDB(options);
            await db.close();
            return 'UNEXPECTED_SUCCESS';
          } catch (error) { return error.code; }
        }, persistent);
        assert.equal(code, 'PERSISTENCE_IN_USE');
        await page.evaluate(() => window.bridgeTest.close());
        const restored = await contender.evaluate(async options => {
          const api = window.bridgeTest;
          await api.open(options);
          try { return await api.query('SELECT id FROM owned'); }
          finally { await api.close(); }
        }, persistent);
        assert.equal(text(restored.rows[0][0]), '42');
      } finally {
        await page.evaluate(() => window.bridgeTest.close());
        await contender.close();
      }
    });

    await t.test('missing cross-origin isolation fails with an actionable error', async () => {
      const plainServer = await serve({ isolated: false });
      const plainPage = await context.newPage();
      try {
        await plainPage.goto(plainServer.url);
        const result = await plainPage.evaluate(async engineModuleUrl => {
          const { createMariaDB } = await import('/src/index.mjs');
          try {
            const db = await createMariaDB({ database: 'joomla', engineModuleUrl });
            await db.close();
            return { isolated: crossOriginIsolated, code: 'UNEXPECTED_SUCCESS' };
          } catch (error) {
            return { isolated: crossOriginIsolated, code: error.code, message: error.message };
          }
        }, new URL('vendor/lite4mariadb/index.mjs', plainServer.url).href);
        assert.equal(result.isolated, false);
        assert.equal(result.code, 'CROSS_ORIGIN_ISOLATION_REQUIRED');
        assert.match(result.message, /isolat|SharedArrayBuffer|COOP|COEP/i);
      } finally {
        await plainPage.close();
        await plainServer.close();
      }
    });

    assert.deepEqual(uncaught, [], 'Browser page must not emit uncaught errors');
  });
}
