import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createMariaDB } from '../../src/index.mjs';

// The C driver and MariaDB engine are real. PHP is native here; php-wasm must
// additionally validate its own Asyncify path when compiling this driver.
test('native PDO executes against MariaDB WebAssembly', { timeout: 180_000 }, async () => {
  const db = await createMariaDB({ database: 'joomla' });
  const script = fileURLToPath(new URL('./run.sh', import.meta.url));
  const fixture = fileURLToPath(new URL('./database.php', import.meta.url));
  const child = spawn('bash', [script, fixture], {
    stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  });
  const lines = createInterface({ input: child.stdout });
  let stderr = '';
  let complete;
  let failure;
  let calls = 0;
  const kill = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const timer = setTimeout(kill, 150_000);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  try {
    for await (const line of lines) {
      try {
        const message = JSON.parse(line);
        if (message.type === 'host') {
          assert.equal(message.name, 'mariadb.v1');
          const value = await db.hostCalls['mariadb.v1'](message.payload);
          calls++;
          child.stdin.write(`${JSON.stringify({ value })}\n`);
        } else {
          assert.equal(message.type, 'complete');
          complete = message.assertions;
        }
      } catch (error) {
        failure = new Error(`Native PDO bridge test failed: ${line}`, { cause: error });
        kill();
        break;
      }
    }
    const { code, signal } = await exited;
    if (failure) throw failure;
    assert.equal(signal, null, `Native PDO terminated: ${signal}; ${stderr}`);
    assert.equal(code, 0, `Native PDO exited ${code}: ${stderr}`);
    assert.ok(complete >= 17, 'PHP integration assertions completed');
    assert.ok(calls >= 20, 'SQL ran through real bridge host calls');
  } finally {
    clearTimeout(timer);
    kill();
    lines.close();
    await db.close();
  }
});
