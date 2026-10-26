export class MariaDBBridgeError extends Error {
  constructor(code, message, { errno = 0, sqlstate = 'HY000', cause } = {}) {
    super(message, { cause });
    this.name = 'MariaDBBridgeError';
    this.code = code;
    this.errno = errno;
    this.sqlstate = sqlstate;
  }
}
export function errorRecord(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'DATABASE_ERROR',
    message: typeof error?.message === 'string' ? error.message : 'Database operation failed',
    errno: Number.isSafeInteger(error?.errno) ? error.errno : 0,
    sqlstate: /^[0-9A-Z]{5}$/.test(error?.sqlstate) ? error.sqlstate : 'HY000',
  };
}
export function fail(code, message, sqlstate = 'HY000') {
  throw new MariaDBBridgeError(code, message, { sqlstate });
}
