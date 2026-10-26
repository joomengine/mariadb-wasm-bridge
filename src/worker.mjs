import { createEngine } from './engine.mjs';
import { MariaDBProtocol, identifier } from './protocol.mjs';
import { errorRecord, fail } from './errors.mjs';

const encoder = new TextEncoder();
let engine;
let protocol;
let options;
let busy = false;
let send;
let listen;
if (typeof process !== 'undefined' && process.versions?.node) {
  const { parentPort } = await import('node:worker_threads');
  if (!parentPort) throw new Error('The MariaDB worker must run in a dedicated worker thread');
  send = value => parentPort.postMessage(value);
  listen = callback => parentPort.on('message', callback);
} else {
  send = value => self.postMessage(value);
  listen = callback => self.addEventListener('message', event => callback(event.data));
}
listen(async message => {
  const { id, operation, args } = message ?? {};
  if (busy) {
    send({ id, ok: false, error: errorRecord(new Error('MariaDB worker received concurrent operations')), fatal: true });
    return;
  }
  busy = true;
  try {
    let value;
    if (operation === 'initialize') {
      if (engine) fail('ALREADY_INITIALIZED', 'MariaDB worker has already been initialized');
      options = args;
      engine = await createEngine({
        dataDir: options.persistence ? `idb://${options.persistence.key}` : 'memory://',
        engineModuleUrl: options.engineModuleUrl,
        wasmUrl: options.wasmUrl,
      });
      await engine.query(`CREATE DATABASE IF NOT EXISTS ${identifier(options.database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      const result = await engine.query('SELECT VERSION() AS version');
      const serverVersion = result.rows?.[0]?.version;
      if (typeof serverVersion !== 'string') fail('INVALID_ENGINE_RESULT', 'MariaDB did not return its server version');
      protocol = new MariaDBProtocol(engine, options.database, serverVersion);
      value = { serverVersion };
    } else {
      if (!protocol) fail('NOT_INITIALIZED', 'MariaDB worker has not been initialized');
      switch (operation) {
        case 'request':
          if (typeof args.payload !== 'string' || encoder.encode(args.payload).byteLength > options.maxRequestBytes) fail('REQUEST_LIMIT', 'Request exceeds maxRequestBytes');
          value = await protocol.handle(args.payload);
          if (encoder.encode(value).byteLength > options.maxResponseBytes) fail('RESPONSE_LIMIT', 'Result exceeds maxResponseBytes; the SQL operation may already have completed');
          break;
        case 'flush': await engine.flush(); break;
        case 'reset': await protocol.reset(); break;
        case 'close':
          try { await protocol.reset(); }
          finally { await engine.close(); protocol = null; }
          break;
        default: fail('UNKNOWN_OPERATION', 'Unknown MariaDB worker operation');
      }
    }
    send({ id, ok: true, value });
  } catch (error) {
    send({ id, ok: false, error: errorRecord(error), fatal: operation === 'initialize' });
  } finally { busy = false; }
});
