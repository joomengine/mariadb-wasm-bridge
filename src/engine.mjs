import { parseEngineResult } from './result.mjs';

/** Isolate the raw JSON ABI of the pinned lite4mariadb 0.1.2 package. */
export async function createEngine({ dataDir = 'memory://', engineModuleUrl, wasmUrl } = {}) {
  const isNode = typeof process !== 'undefined' && Boolean(process.versions?.node);
  if (typeof WebAssembly !== 'object' || typeof SharedArrayBuffer !== 'function' || (!isNode && globalThis.crossOriginIsolated !== true)) {
    throw engineError('MariaDB requires WebAssembly, SharedArrayBuffer and browser cross-origin isolation', 'HYC00', 0, 'UNSUPPORTED_RUNTIME');
  }
  if (typeof dataDir !== 'string' || !dataDir || dataDir.includes('\0')) {
    throw new TypeError('dataDir must be a non-empty string without NUL bytes');
  }
  const moduleUrl = engineModuleUrl ?? new URL('../vendor/lite4mariadb/index.mjs', import.meta.url).href;
  const { Lite4MariaDB } = await import(moduleUrl);
  const options = { dataDir };
  if (wasmUrl !== undefined) {
    const resolved = new URL(wasmUrl, import.meta.url).href;
    options.locateFile = (path, prefix) => path.endsWith('.wasm') ? resolved : `${prefix}${path}`;
  }
  const database = await Lite4MariaDB.create(options);
  let closed = false;

  function requireOpen() {
    if (closed) throw engineError('The MariaDB engine is closed', 'HY000', 2006);
  }

  function query(sql, stringMode, session = 0) {
    requireOpen();
    if (typeof sql !== 'string' || !sql.trim()) throw new TypeError('SQL must be a non-empty string');
    // The upstream C ABI accepts NUL-terminated strings, not a byte length.
    if (sql.includes('\0')) throw engineError('SQL cannot contain NUL bytes; encode binary values as hexadecimal literals', 'HY000');
    requireSingleStatement(sql, stringMode);
    const module = database.mod;
    // Emscripten string arguments use the C stack. Extension install queries can
    // exceed MariaDB's stack limit, so keep their UTF-8 bytes on the heap.
    const size = module.lengthBytesUTF8(sql) + 1;
    if (!Number.isSafeInteger(size) || size < 1 || size > 0x7fffffff) {
      throw engineError('SQL exceeds the engine allocation limit', 'HY001');
    }
    const input = module._malloc(size);
    if (!Number.isSafeInteger(input) || input <= 0) throw engineError('Cannot allocate SQL input', 'HY001');
    let pointer;
    try {
      module.stringToUTF8(sql, input, size);
      pointer = session === 0 ? module._l4m_query(input) : module._l4m_session_query(session, input);
    } finally { module._free(input); }
    if (!pointer) throw engineError('MariaDB returned an empty result pointer', 'HY000');
    let json;
    try { json = module.UTF8ToString(pointer); }
    finally { module._l4m_free(pointer); }
    let result;
    try { result = parseEngineResult(json); }
    catch (cause) { throw new Error('MariaDB returned invalid JSON', { cause }); }
    if (!result || typeof result !== 'object') throw engineError('MariaDB returned an invalid result envelope', 'HY000');
    if (result.ok !== true) throw engineError(result.error || 'MariaDB query failed', result.sqlstate || 'HY000', result.errno);
    if (!Array.isArray(result.rows)) throw engineError('MariaDB returned invalid rows', 'HY000');
    if (result.fields !== undefined) {
      if (!Array.isArray(result.fields) || !result.fields.every((field) => typeof field === 'string')) throw engineError('MariaDB returned invalid column names', 'HY000');
      if (!Array.isArray(result.rowValues)) throw engineError('MariaDB returned invalid positional rows', 'HY000');
      if (!Array.isArray(result.types) || result.types.length !== result.fields.length) throw engineError('MariaDB returned invalid column metadata', 'HY000');
      // Upstream 0.1.2 does not hex-encode BIT or GEOMETRY. Their arbitrary
      // bytes pass through UTF8ToString and can already have been corrupted.
      if (result.types.some(([type]) => type === 16 || type === 255)) throw engineError('BIT and GEOMETRY results require an explicit SQL cast to a supported numeric, text or binary type', 'HYC00', 0, 'UNSUPPORTED_RESULT');
    }
    if (result.affected !== undefined && !Number.isSafeInteger(result.affected)) throw engineError('MariaDB affected-row count exceeds the supported integer range', '22003');
    return result;
  }

  return {
    query,
    openSession() {
      requireOpen();
      if (['_l4m_session_open', '_l4m_session_query', '_l4m_session_close'].some(name => typeof database.mod[name] !== 'function')) {
        throw engineError('The MariaDB assets do not provide independent sessions; reload the matching bridge and engine release', 'HYC00', 0, 'ENGINE_ABI_MISMATCH');
      }
      const session = database.mod._l4m_session_open();
      if (!Number.isInteger(session) || session < 1) throw engineError('Cannot open another MariaDB session (maximum 32)', '08004', 1040, 'CONNECTION_LIMIT');
      return session;
    },
    closeSession(session) { requireOpen(); database.mod._l4m_session_close(session); },
    async flush() { requireOpen(); await database.persist(); },
    async close() {
      if (closed) return;
      closed = true;
      // Service queued Emscripten pthread lifecycle/proxy messages before native
      // shutdown enters blocking joins. Promise microtasks do not yield the worker.
      await new Promise(resolve => setTimeout(resolve, 0));
      // Upstream closes InnoDB before the final IDBFS sync, preserving shutdown writes.
      await database.close();
    },
  };
}

function engineError(message, sqlstate, errno = 0, code = 'DATABASE_ERROR') {
  const error = new Error(message);
  error.sqlstate = sqlstate;
  error.errno = Number.isInteger(errno) ? errno : 0;
  error.code = code;
  return error;
}

/**
 * Upstream enables CLIENT_MULTI_STATEMENTS but discards later results. Check
 * every string mode so ANSI_QUOTES/NO_BACKSLASH_ESCAPES cannot hide a script.
 * Ambiguous quoted strings can instead be supplied as hexadecimal literals.
 */
function requireSingleStatement(sql, stringMode = {}) {
  // Only the protocol supplies modes, obtained from the server immediately
  // before execution. Direct engine callers retain conservative checking.
  const backslashModes = typeof stringMode.backslashEscapes === 'boolean' ? [stringMode.backslashEscapes] : [false, true];
  const quoteModes = typeof stringMode.ansiQuotes === 'boolean' ? [stringMode.ansiQuotes] : [false, true];
  for (const backslashEscapes of backslashModes) {
    for (const ansiQuotes of quoteModes) {
      let terminated = false;
      for (let i = 0; i < sql.length;) {
        const character = sql[i];
        if (/\s/.test(character)) { i++; continue; }
        if (character === '#' || (character === '-' && sql[i + 1] === '-' && (sql[i + 2] === undefined || sql[i + 2] <= ' '))) {
          const end = sql.indexOf('\n', i);
          i = end < 0 ? sql.length : end + 1;
          continue;
        }
        if (character === '/' && sql[i + 1] === '*') {
          const end = sql.indexOf('*/', i + 2);
          const stop = end < 0 ? sql.length : end;
          const executable = sql[i + 2] === '!' || (sql[i + 2] === 'M' && sql[i + 3] === '!');
          if (executable && (terminated || sql.slice(i + 2, stop).includes(';'))) throw engineError('Executable SQL comments cannot contain statement separators', 'HYC00', 0, 'MULTIPLE_STATEMENTS');
          i = end < 0 ? sql.length : end + 2;
          continue;
        }
        if (terminated) throw engineError('Only one SQL statement is allowed per query', 'HYC00', 0, 'MULTIPLE_STATEMENTS');
        if (character === ';') { terminated = true; i++; continue; }
        if (character === "'" || character === '"' || character === '`') {
          const quote = character;
          const escape = backslashEscapes && quote !== '`' && !(ansiQuotes && quote === '"');
          i++;
          while (i < sql.length) {
            if (escape && sql[i] === '\\') { i += 2; continue; }
            if (sql[i] === quote) {
              if (sql[i + 1] === quote) { i += 2; continue; }
              i++;
              break;
            }
            i++;
          }
          continue;
        }
        i++;
      }
    }
  }
}
