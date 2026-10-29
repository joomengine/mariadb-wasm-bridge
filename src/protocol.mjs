import { errorRecord, fail } from './errors.mjs';

export const HOST_CALL = 'mariadb.v1';
export const PROTOCOL_VERSION = 1;

/** Validate a logical database name and return its quoted SQL identifier. */
export function identifier(value, label = 'database') {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value)) {
    fail('INVALID_IDENTIFIER', `${label} must contain 1–64 ASCII letters, digits or underscores and start with a letter or underscore`, '42000');
  }
  return `\`${value}\``;
}

export class MariaDBProtocol {
  constructor(engine, database, serverVersion) {
    this.engine = engine;
    this.database = database;
    this.quotedDatabase = identifier(database);
    this.serverVersion = serverVersion;
    this.connections = new Map();
  }

  /** All host calls return a versioned JSON envelope, including failures. */
  async handle(payloadJSON) {
    try {
      if (typeof payloadJSON !== 'string') fail('INVALID_REQUEST', 'Host-call payload must be a JSON string');
      let payload;
      try { payload = JSON.parse(payloadJSON); }
      catch { fail('INVALID_REQUEST', 'Host-call payload is not valid JSON'); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('INVALID_REQUEST', 'Host-call payload must be an object');
      if (payload.version !== PROTOCOL_VERSION) fail('UNSUPPORTED_PROTOCOL', 'MariaDB host-call protocol version must be 1');
      let result;
      switch (payload.op) {
        case 'connect': result = await this.connect(payload); break;
        case 'query': result = await this.query(payload); break;
        case 'close':
          this.close(payload.connection);
          result = {};
          break;
        default: fail('UNKNOWN_OPERATION', 'Unsupported MariaDB host-call operation');
      }
      return JSON.stringify({ version: PROTOCOL_VERSION, ok: true, result });
    } catch (error) {
      return JSON.stringify({ version: PROTOCOL_VERSION, ok: false, error: errorRecord(error) });
    }
  }

  async connect(payload) {
    if ((payload.database ?? this.database) !== this.database) fail('DATABASE_MISMATCH', 'The requested database does not match this bridge instance', '3D000');
    if (!['', 'root'].includes(payload.user ?? '') || (payload.password ?? '') !== '') fail('UNSUPPORTED_CREDENTIALS', 'Embedded MariaDB accepts only an empty password and the root or empty user', '28000');
    const requestedCharset = payload.charset ?? 'utf8mb4';
    if (!['utf8', 'utf8mb3', 'utf8mb4'].includes(requestedCharset)) fail('UNSUPPORTED_CHARSET', 'The bridge supports utf8mb3 and utf8mb4', 'HYC00');
    const charset = requestedCharset === 'utf8' ? 'utf8mb3' : requestedCharset;
    const session = this.engine.openSession();
    const connection = globalThis.crypto.randomUUID();
    try {
      await this.engine.query(`SET NAMES ${charset}`, undefined, session);
      await this.engine.query(`USE ${this.quotedDatabase}`, undefined, session);
      this.connections.set(connection, { session, charset });
      return { connection, serverVersion: this.serverVersion };
    } catch (error) { this.engine.closeSession(session); throw error; }
  }

  requireConnection(connection) {
    const owned = typeof connection === 'string' && this.connections.get(connection);
    if (!owned) fail('INVALID_CONNECTION', 'The MariaDB connection is invalid or closed', '08003');
    return owned;
  }

  close(connection) {
    const { session } = this.requireConnection(connection);
    this.engine.closeSession(session);
    this.connections.delete(connection);
  }

  async query(payload) {
    const { session, charset } = this.requireConnection(payload.connection);
    const query = (sql, mode) => this.engine.query(sql, mode, session);
    if (typeof payload.sql !== 'string' || !payload.sql.trim()) fail('INVALID_QUERY', 'SQL must be a non-empty string', '42000');
    // Both supported connection charsets cross the engine ABI as valid UTF-8.
    // Preserve the negotiated charset after application SQL changes it.
    await query(`SET NAMES ${charset}`);
    // Joomla's MySQL query builder strips the outer quotes from PDO::quote().
    // Its driver therefore needs conventional MySQL backslash escaping, whose
    // meaning must not change when application SQL enables NO_BACKSLASH_ESCAPES.
    const modeResult = await query('SELECT @@SESSION.sql_mode AS sql_mode');
    const modeString = modeResult.rows?.[0]?.sql_mode;
    if (typeof modeString !== 'string' || !/^[A-Z0-9_,]*$/.test(modeString)) fail('INVALID_ENGINE_RESULT', 'MariaDB returned invalid SQL modes');
    const modes = modeString.split(',').filter(Boolean);
    if (modes.includes('NO_BACKSLASH_ESCAPES')) {
      const retained = modes.filter(mode => mode !== 'NO_BACKSLASH_ESCAPES').join(',');
      await query(`SET SESSION sql_mode = '${retained}'`);
    }
    const raw = await query(payload.sql, { backslashEscapes: true, ansiQuotes: modes.includes('ANSI_QUOTES') });
    if (raw.affected !== undefined && (!Number.isSafeInteger(raw.affected) || raw.affected < 0)) fail('INVALID_ENGINE_RESULT', 'MariaDB returned an affected-row count outside the supported integer range', '22003');
    const columns = (raw.fields ?? []).map((name, index) => {
      const [type, charset, flags] = raw.types[index];
      return { name, table: '', type, charset, flags };
    });
    const rows = (raw.rowValues ?? []).map(row => row.map(encodeCell));
    const status = await query('SELECT CAST(LAST_INSERT_ID() AS CHAR) AS insert_id, @@in_transaction AS active_transaction');
    const metadata = status.rows[0];
    if (!metadata || !/^\d+$/.test(metadata.insert_id) || !['0', '1'].includes(metadata.active_transaction)) {
      fail('INVALID_ENGINE_RESULT', 'MariaDB returned invalid connection metadata');
    }
    return {
      columns,
      rows,
      affectedRows: String(raw.affected ?? raw.rows.length),
      insertId: metadata.insert_id,
      inTransaction: metadata.active_transaction === '1',
    };
  }

  async reset() {
    // Closing a real server connection rolls back only that session's unfinished work.
    for (const connection of this.connections.keys()) this.close(connection);
  }
}

const encoder = new TextEncoder();

function encodeCell(value) {
  if (value === null) return null;
  let bytes;
  if (typeof value === 'string') {
    bytes = encoder.encode(value);
  } else if (value && typeof value === 'object' && typeof value.$h === 'string' && /^(?:[0-9a-fA-F]{2})*$/.test(value.$h)) {
    bytes = new Uint8Array(value.$h.length / 2);
    for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(value.$h.slice(index * 2, index * 2 + 2), 16);
  } else {
    fail('INVALID_ENGINE_RESULT', 'MariaDB returned a cell outside the raw wire format');
  }
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  // Encode divisible-by-three chunks without building one JS string per byte.
  const parts = [];
  for (let index = 0; index < bytes.length; index += 24576) {
    parts.push(btoa(String.fromCharCode(...bytes.subarray(index, index + 24576))));
  }
  return parts.join('');
}
