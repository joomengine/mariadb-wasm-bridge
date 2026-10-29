import { MariaDBBridgeError, errorRecord, fail } from './errors.mjs';
import { HOST_CALL, identifier } from './protocol.mjs';
export { MariaDBBridgeError } from './errors.mjs';
export { HOST_CALL, PROTOCOL_VERSION } from './protocol.mjs';

const encoder = new TextEncoder();
const isNode = typeof process !== 'undefined' && Boolean(process.versions?.node);
function positiveInteger(value, name, fallback, maximum = 2 ** 31 - 1) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) fail('INVALID_ARGUMENT', `${name} must be an integer between 1 and ${maximum}`);
  return result;
}
function absoluteURL(value, name) {
  if (typeof value !== 'string' && !(value instanceof URL)) fail('INVALID_ARGUMENT', `${name} must be a URL`);
  let url;
  try { url = new URL(String(value), globalThis.location?.href); }
  catch { fail('INVALID_ARGUMENT', `${name} must be an absolute URL in Node.js or a resolvable browser URL`); }
  if (!['https:', 'http:', ...(isNode ? ['file:'] : [])].includes(url.protocol)) fail('INVALID_ARGUMENT', `${name} must use HTTP(S) or a Node.js file URL`);
  return url.href;
}
function validateOptions(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_ARGUMENT', 'options must be an object');
  const options = {
    database: input.database ?? 'joomla',
    timeoutMs: positiveInteger(input.timeoutMs, 'timeoutMs', 30_000),
    startupTimeoutMs: positiveInteger(input.startupTimeoutMs, 'startupTimeoutMs', 120_000),
    maxRequestBytes: positiveInteger(input.maxRequestBytes, 'maxRequestBytes', 32 * 1024 * 1024),
    maxResponseBytes: positiveInteger(input.maxResponseBytes, 'maxResponseBytes', 64 * 1024 * 1024),
    maxQueuedRequests: positiveInteger(input.maxQueuedRequests, 'maxQueuedRequests', 64, 1024),
    maxQueuedBytes: positiveInteger(input.maxQueuedBytes, 'maxQueuedBytes', 128 * 1024 * 1024),
  };
  identifier(options.database);
  for (const name of ['engineModuleUrl', 'wasmUrl']) {
    if (input[name] !== undefined) options[name] = absoluteURL(input[name], name);
  }
  if (input.persistence !== undefined) {
    const key = input.persistence?.key;
    if (!input.persistence || typeof input.persistence !== 'object' || Array.isArray(input.persistence)
      || typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)) {
      fail('INVALID_ARGUMENT', 'persistence.key must contain 1–128 letters, digits, dots, underscores or hyphens and start with a letter or digit');
    }
    if (isNode) fail('PERSISTENCE_UNAVAILABLE', 'IndexedDB persistence is supported only in browsers');
    if (!globalThis.indexedDB || !globalThis.navigator?.locks?.request) fail('PERSISTENCE_UNAVAILABLE', 'Persistence requires IndexedDB and the Web Locks API');
    options.persistence = { key };
  }
  return options;
}
async function acquirePersistenceLock(key) {
  if (!key) return async () => {};
  let unlock;
  const held = new Promise(resolve => { unlock = resolve; });
  let resolveAcquired;
  let rejectAcquired;
  const acquired = new Promise((resolve, reject) => { resolveAcquired = resolve; rejectAcquired = reject; });
  const complete = navigator.locks.request(`joomengine-mariadb:${key}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) {
      rejectAcquired(new MariaDBBridgeError('PERSISTENCE_IN_USE', 'Another instance is already using this persistent database'));
      return;
    }
    resolveAcquired();
    await held;
  });
  complete.catch(rejectAcquired);
  await acquired;
  return async () => { unlock(); await complete; };
}

class MariaDBBridge {
  #worker;
  #options;
  #releaseLock;
  #state = 'starting';
  #nextId = 0;
  #pending = null;
  #queue = Promise.resolve();
  #queuedCount = 0;
  #queuedBytes = 0;
  #closePromise;
  #termination;
  #failure;
  constructor(worker, options, releaseLock) {
    this.#worker = worker;
    this.#options = options;
    this.#releaseLock = releaseLock;
    const receive = message => this.#receive(message);
    const failed = message => this.#kill(new MariaDBBridgeError('WORKER_FAILED', message));
    if (typeof worker.on === 'function') {
      worker.on('message', receive);
      worker.on('error', error => failed(error.message));
      worker.on('messageerror', () => failed('MariaDB worker returned an unreadable message'));
      worker.on('exit', code => { if (this.#state !== 'closed') failed(`MariaDB worker exited unexpectedly (${code})`); });
    } else {
      worker.addEventListener('message', event => receive(event.data));
      worker.addEventListener('error', event => failed(event.message || 'MariaDB worker failed'));
      worker.addEventListener('messageerror', () => failed('MariaDB worker returned an unreadable message'));
    }
    Object.defineProperty(this, 'hostCalls', { enumerable: true, value: Object.freeze({
      [HOST_CALL]: async payload => {
        try {
          if (typeof payload !== 'string') fail('INVALID_REQUEST', 'Host-call payload must be a JSON string');
          return await this.#enqueue('request', { payload }, encoder.encode(payload).byteLength);
        } catch (error) {
          return JSON.stringify({ version: 1, ok: false, error: errorRecord(error) });
        }
      },
    }) });
  }
  get state() { return this.#state; }
  async initialize() {
    try {
      const result = await this.#send('initialize', this.#options, this.#options.startupTimeoutMs);
      Object.defineProperty(this, 'serverVersion', { enumerable: true, value: result.serverVersion });
      this.#state = 'ready';
      return this;
    } catch (error) {
      await this.#kill(error);
      throw error;
    }
  }
  async flush() { return this.#enqueue('flush', {}, 0); }
  async reset() { return this.#enqueue('reset', {}, 0); }
  close() {
    if (this.#closePromise) return this.#closePromise;
    if (this.#state === 'closed') return this.#termination ?? Promise.resolve();
    this.#state = 'closing';
    this.#closePromise = this.#queue.then(async () => {
      if (this.#state === 'closed') { await this.#termination; return; }
      try { await this.#send('close', {}, this.#options.timeoutMs); }
      finally { await this.#kill(new MariaDBBridgeError('CLOSED', 'MariaDB bridge is closed')); }
    });
    return this.#closePromise;
  }
  #enqueue(operation, args, size) {
    if (this.#state !== 'ready') return Promise.reject(this.#failure ?? new MariaDBBridgeError('CLOSED', 'MariaDB bridge is closing or closed'));
    if (size > this.#options.maxRequestBytes) return Promise.reject(new MariaDBBridgeError('REQUEST_LIMIT', 'Request exceeds maxRequestBytes'));
    if (this.#queuedCount >= this.#options.maxQueuedRequests || this.#queuedBytes + size > this.#options.maxQueuedBytes) {
      return Promise.reject(new MariaDBBridgeError('QUEUE_LIMIT', 'MariaDB bridge queue is full'));
    }
    this.#queuedCount++;
    this.#queuedBytes += size;
    const result = this.#queue.then(() => {
      if (this.#state === 'closed') throw this.#failure ?? new MariaDBBridgeError('CLOSED', 'MariaDB bridge is closed');
      return this.#send(operation, args, this.#options.timeoutMs);
    }).finally(() => { this.#queuedCount--; this.#queuedBytes -= size; });
    this.#queue = result.catch(() => {});
    return result;
  }
  #send(operation, args, timeout) {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#kill(new MariaDBBridgeError('TIMEOUT', `MariaDB ${operation} timed out after ${timeout} ms; its worker was terminated`));
      }, timeout);
      this.#pending = { id, resolve, reject, timer };
      try { this.#worker.postMessage({ id, operation, args }); }
      catch (error) { this.#kill(new MariaDBBridgeError('WORKER_FAILED', error.message, { cause: error })); }
    });
  }
  #receive(message) {
    if (this.#state === 'closed' || !message || this.#pending?.id !== message.id) return;
    const pending = this.#pending;
    this.#pending = null;
    clearTimeout(pending.timer);
    if (message.ok === true) pending.resolve(message.value);
    else {
      const record = errorRecord(message.error);
      const error = new MariaDBBridgeError(record.code, record.message, record);
      pending.reject(error);
      if (message.fatal) this.#kill(error);
    }
  }
  #kill(error) {
    if (this.#termination) return this.#termination;
    this.#state = 'closed';
    this.#failure = error;
    if (this.#pending) {
      clearTimeout(this.#pending.timer);
      this.#pending.reject(error);
      this.#pending = null;
    }
    this.#termination = Promise.resolve().then(() => this.#worker.terminate()).then(() => this.#releaseLock());
    this.#termination.catch(() => {});
    return this.#termination;
  }
}
/** Create an isolated MariaDB engine with a serialized, bounded host-call queue. */
export async function createMariaDB(input = {}) {
  const options = validateOptions(input);
  if (!isNode && (globalThis.crossOriginIsolated !== true || typeof SharedArrayBuffer !== 'function')) {
    fail('CROSS_ORIGIN_ISOLATION_REQUIRED', 'MariaDB requires cross-origin isolation (COOP/COEP) and SharedArrayBuffer');
  }
  const releaseLock = await acquirePersistenceLock(options.persistence?.key);
  let worker;
  try {
    const url = new URL('./worker.mjs', import.meta.url);
    if (isNode) {
      const { Worker } = await import('node:worker_threads');
      worker = new Worker(url, { type: 'module', execArgv: [] });
    } else {
      if (typeof Worker !== 'function') fail('WORKER_UNAVAILABLE', 'This browser does not support dedicated module workers');
      worker = new Worker(url, { type: 'module', name: 'joomengine-mariadb' });
    }
  } catch (error) {
    await releaseLock();
    throw error;
  }
  return new MariaDBBridge(worker, options, releaseLock).initialize();
}
