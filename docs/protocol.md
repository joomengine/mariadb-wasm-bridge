# MariaDB host protocol 1

`createMariaDB().hostCalls['mariadb.v1']` accepts a JSON string and resolves a JSON
string. Pass this handler to `createPHP`. Native PHP uses the runtime's existing
`php_wasm_host_call('mariadb.v1', $json)` asynchronous transport.

Every request includes `version: 1` and `op`. Responses are one of:

```json
{"version":1,"ok":true,"result":{}}
```

```json
{"version":1,"ok":false,"error":{"code":"INVALID_CONNECTION","sqlstate":"08003","errno":0,"message":"The MariaDB connection lease is invalid or closed"}}
```

Host-handler transport/timeout failures also return the error envelope. Direct
JavaScript lifecycle calls (`flush`, `reset`, `close`) reject on failure.

| Operation | Request properties | Success result |
| --- | --- | --- |
| `connect` | `database` (defaults to configured database), `user` (root/empty), `password` (empty), `charset` (`utf8mb4` default; `utf8mb3` or `utf8` also accepted) | `connection` opaque string; `serverVersion` string |
| `query` | `connection`, `sql` (one statement) | Columns, positional rows, affected rows, insert ID and transaction state |
| `close` | `connection` | Empty object, after rollback and lease release |

One engine has one active lease. The token prevents accidental mixing of handles;
it is not authentication between scripts sharing the same application instance.
The bridge creates the configured database on startup. Connection requests may
only select that database, but SQL has the privileges of the embedded engine.

## Query result

```json
{
  "columns": [{"name":"value","table":"","type":253,"charset":45,"flags":0}],
  "rows": [["aGVsbG8="], [null]],
  "affectedRows": "2",
  "insertId": "0",
  "inTransaction": false
}
```

Non-null cells are base64 bytes. Text bytes are UTF-8; binary cells are their
original bytes. Numeric values are decimal text bytes, not JSON numbers. This
retains BIGINT/DECIMAL precision on wasm32 PHP and in JavaScript. Type, charset
and flags use MariaDB metadata integers; source table names are unavailable.
`affectedRows` and `insertId` are decimal strings. Results are buffered and
forward-only in PDO. Duplicate column names retain every positional value. The
decoder preserves native JSON row-member order before object-key replacement,
and validates each member against the corresponding field name. PDO applies its
normal numeric, associative and named fetch semantics to those original cells.

Errors retain MariaDB's SQLSTATE and errno when available. Stable bridge codes
identify validation, lease, queue, request/response limit and lifecycle failures.
Errors do not promise rollback: SQL may commit implicitly, and a response limit
or timeout may occur after execution. Do not automatically replay writes.

## Lifetime

Close PDO handles before flushing the bridge. `reset()` drains accepted work,
rolls back and releases an abandoned lease, for example after terminating PHP.
It does not clear every server session variable or temporary table. If the DB
worker itself times out, it is terminal and must be replaced; `close()` then
releases resources without claiming that unflushed data was saved.

Queries restore supported connection settings and issue a metadata query. Thus
SQL diagnostic functions such as `ROW_COUNT()`, `FOUND_ROWS()` and warnings may
reflect bridge statements. Use returned affected-row metadata. Protocol version
and native driver version must be recorded with PHP build assets and tested as a
pair before the playground selects them.
