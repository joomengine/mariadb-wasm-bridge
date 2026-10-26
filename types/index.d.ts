export class MariaDBBridgeError extends Error {
  readonly code: string;
  readonly errno: number;
  readonly sqlstate: string;
  constructor(code: string, message: string, options?: { errno?: number; sqlstate?: string; cause?: unknown });
}
export const HOST_CALL: 'mariadb.v1';
export const PROTOCOL_VERSION: 1;
export interface MariaDBOptions {
  /** One database per bridge; ASCII identifier, default joomla. */
  database?: string;
  /** Active-operation deadline; expiration terminates the worker. Default 30000. */
  timeoutMs?: number;
  /** Engine loading and persistence restoration deadline. Default 120000. */
  startupTimeoutMs?: number;
  /** UTF-8 host-call request limit, default 8 MiB. */
  maxRequestBytes?: number;
  /** UTF-8 host-call response limit, default 16 MiB. */
  maxResponseBytes?: number;
  /** Accepted active/queued operation limit, default 64. */
  maxQueuedRequests?: number;
  /** Accepted active/queued request bytes, default 32 MiB. */
  maxQueuedBytes?: number;
  /** Browser IndexedDB store protected by an exclusive Web Lock. */
  persistence?: { key: string };
  /** Upstream index.mjs URL; bare dependency in Node, vendor assets in browser by default. */
  engineModuleUrl?: string | URL;
  /** Override the upstream engine WASM asset URL. */
  wasmUrl?: string | URL;
}
export interface MariaDBBridge {
  readonly state: 'starting' | 'ready' | 'closing' | 'closed';
  readonly serverVersion: string;
  /** Pass directly to createPHP({ hostCalls: db.hostCalls }). */
  readonly hostCalls: Readonly<{ 'mariadb.v1': (payloadJSON: string) => Promise<string> }>;
  /** Explicit durability boundary for browser persistence. */
  flush(): Promise<void>;
  /** Roll back and discard the connection lease after abandoned PHP execution. */
  reset(): Promise<void>;
  /** Drain accepted work, roll back, persist, terminate, and release the lock. */
  close(): Promise<void>;
}
export interface BridgeColumn {
  name: string;
  /** Empty: upstream does not expose origin-table metadata. */
  table: '';
  type: number;
  charset: number;
  flags: number;
}
export interface QueryResult {
  columns: BridgeColumn[];
  /** Positional null or base64 bytes; numbers retain exact decimal text. */
  rows: (string | null)[][];
  affectedRows: string;
  /** MariaDB LAST_INSERT_ID(), retained for the session until changed. */
  insertId: string;
  inTransaction: boolean;
}
export function createMariaDB(options?: MariaDBOptions): Promise<MariaDBBridge>;
