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
    this.connection = null;
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
          this.requireConnection(payload.connection);
          await this.reset();
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
    if (this.connection !== null) fail('CONNECTION_IN_USE', 'The embedded MariaDB connection is already leased', '08004');
    if ((payload.database ?? this.database) !== this.database) fail('DATABASE_MISMATCH', 'The requested database does not match this bridge instance', '3D000');
    if (!['', 'root'].includes(payload.user ?? '') || (payload.password ?? '') !== '') fail('UNSUPPORTED_CREDENTIALS', 'Embedded MariaDB accepts only an empty password and the root or empty user', '28000');
    if ((payload.charset ?? 'utf8mb4') !== 'utf8mb4') fail('UNSUPPORTED_CHARSET', 'The bridge requires utf8mb4', 'HYC00');
    await this.engine.query('ROLLBACK');
    await this.engine.query('SET autocommit=1');
    await this.engine.query('SET NAMES utf8mb4');
    await this.engine.query(`USE ${this.quotedDatabase}`);
    await this.engine.query('SELECT LAST_INSERT_ID(0)');
    this.connection = globalThis.crypto.randomUUID();
    return { connection: this.connection, serverVersion: this.serverVersion };
  }

  requireConnection(connection) {
    if (typeof connection !== 'string' || this.connection === null || connection !== this.connection) {
      fail('INVALID_CONNECTION', 'The MariaDB connection lease is invalid or closed', '08003');
    }
  }

  async query(payload) {
    this.requireConnection(payload.connection);
    if (typeof payload.sql !== 'string' || !payload.sql.trim()) fail('INVALID_QUERY', 'SQL must be a non-empty string', '42000');
    // Results cross the upstream ABI as UTF-8 JSON. Reassert this even after a
    // previous caller changed connection settings with SQL.
    await this.engine.query('SET NAMES utf8mb4');
    // Joomla's MySQL query builder strips the outer quotes from PDO::quote().
    // Its driver therefore needs conventional MySQL backslash escaping, whose
    // meaning must not change when application SQL enables NO_BACKSLASH_ESCAPES.
    const modeResult = await this.engine.query('SELECT @@SESSION.sql_mode AS sql_mode');
    const modeString = modeResult.rows?.[0]?.sql_mode;
    if (typeof modeString !== 'string' || !/^[A-Z0-9_,]*$/.test(modeString)) fail('INVALID_ENGINE_RESULT', 'MariaDB returned invalid SQL modes');
    const modes = modeString.split(',').filter(Boolean);
    if (modes.includes('NO_BACKSLASH_ESCAPES')) {
      const retained = modes.filter(mode => mode !== 'NO_BACKSLASH_ESCAPES').join(',');
      await this.engine.query(`SET SESSION sql_mode = '${retained}'`);
    }
    const raw = await this.engine.query(payload.sql, { backslashEscapes: true, ansiQuotes: modes.includes('ANSI_QUOTES') });
    if (raw.affected !== undefined && (!Number.isSafeInteger(raw.affected) || raw.affected < 0)) fail('INVALID_ENGINE_RESULT', 'MariaDB returned an affected-row count outside the supported integer range', '22003');
    const columns = (raw.fields ?? []).map((name, index) => {
      const [type, charset, flags] = raw.types[index];
      return { name, table: '', type, charset, flags };
    });
    const rows = raw.rows.map((row) => columns.map(({ name }) => encodeCell(row[name])));
    const status = await this.engine.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) AS insert_id, @@in_transaction AS active_transaction');
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
    await this.engine.query('ROLLBACK');
    await this.engine.query('SET autocommit=1');
    this.connection = null;
  }
}

const encoder = new TextEncoder();
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

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
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    encoded += alphabet[first >> 2] + alphabet[((first & 3) << 4) | (second >> 4)]
      + (index + 1 < bytes.length ? alphabet[((second & 15) << 2) | (third >> 6)] : '=')
      + (index + 2 < bytes.length ? alphabet[third & 63] : '=');
  }
  return encoded;
}
