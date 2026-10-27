# MariaDB WASM Bridge

A versioned MariaDB WebAssembly bridge and native PDO driver source for
[JoomEngine PHP WASM](https://github.com/joomengine/php-wasm). SQL executes in
real MariaDB through [lite4mariadb](https://github.com/shyim/lite4mariadb); there
is no SQLite translation, database service, Docker runtime or WordPress dependency.

## Implementation status

This initial implementation supplies a dedicated database worker, the versioned
`mariadb.v1` host protocol, browser persistence, native PDO driver source, and
real-engine tests. It registers PDO's `mysql` driver name so Joomla can use its
normal PDO MySQL database path.

**The native driver must still be statically compiled into a `php-wasm` engine.**
Installing this JavaScript package alone does not add a PDO driver to PHP. Native
PHP tests against MariaDB WASM do not certify a combined PHP-WASM build, Joomla
installation or JCB compilation. Those are the next integration steps.

## Use from JavaScript

Requires Node.js 24+ for development. Clone this repository, run `npm ci`, then
`npm run prepare:engine`. Tests and release packaging run preparation automatically.
The entry point is `src/index.mjs`; npm packages and standalone release archives
include the prepared engine under `vendor/lite4mariadb`, with no consumer build or
postinstall step.

```js
import { createMariaDB } from './src/index.mjs';
const database = await createMariaDB({ database: 'joomla' });
const call = async (request) => {
  const response = JSON.parse(await database.hostCalls['mariadb.v1'](
    JSON.stringify({ version: 1, ...request }),
  ));
  if (!response.ok) throw new Error(response.error.message);
  return response.result;
};
try {
  const { connection } = await call({ op: 'connect', database: 'joomla' });
  const result = await call({ op: 'query', connection, sql: 'SELECT VERSION() AS version' });
  // Cells are null or base64-encoded bytes; numeric values retain exact text.
  console.log(atob(result.rows[0][0]));
  await call({ op: 'close', connection });
  await database.flush();
} finally {
  await database.close();
}
```

Pass `database.hostCalls` to `createPHP`'s `hostCalls` option. A runtime containing
`pdo_mariadb_wasm` then uses `new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '')`.
See [docs/integration.md](docs/integration.md) for native integration steps.

## Browser storage and hosting

Use `persistence: { key: 'site-unique-key' }` for IndexedDB. Each key has an
exclusive Web Lock; another tab cannot open it concurrently. Use a separate key
for each playground site/version. Call `flush()` at checkpoints and `close()`
while the page is active. Browser storage is not a backup; unload handlers cannot
guarantee a completed flush.

MariaDB uses pthreads and requires a secure context, `SharedArrayBuffer` and
cross-origin isolation. A conventional static host needs these response headers:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

GitHub Pages cannot set these custom headers itself. The playground needs a tested
service-worker isolation strategy and request routing before Pages is supported.
This bridge does not install or own that service worker.

For npm-based browser builds, stage this package’s `src/` and prepared `vendor/`
directories together as static assets. The default engine URL resolves relative
to `src/engine.mjs`; release archives use the same layout and need no bundler.
Related JS/WASM assets must satisfy worker origin/CORS policies.

## Compatibility boundaries

- One engine has one native connection. A second simultaneous PDO handle fails;
  create another bridge for an independent site.
- PDO emulated prepares are supported. Native server-side prepares, `mysqli`,
  networking and password authentication are not implemented. The embedded engine
  accepts root or an empty username with an empty password.
- Connections use `utf8mb4`. Binary/NUL values survive transport. BIGINT and
  DECIMAL values remain strings.
- The bridge disables `NO_BACKSLASH_ESCAPES` before each query so PDO and Joomla
  text quoting stay consistent. Other SQL mode flags are preserved.
- BIT and GEOMETRY results require an explicit SQL cast to a supported numeric,
  text or binary type; upstream otherwise risks corrupting their bytes.
- One SQL statement is accepted per call. Duplicate result-column names are
  rejected because upstream's object rows cannot preserve them; use aliases.
- Column names and MariaDB type/charset/flags are available; source table names
  are unavailable and returned empty.
- `lastInsertId()` uses session `LAST_INSERT_ID()`, retained until another insert
  or reset. It is not a per-statement native getter. Internal metadata queries
  also change diagnostic SQL state such as `ROW_COUNT()` and warnings.
- Close/reset rolls back transactions and restores autocommit. It is not a full
  MySQL session reset: temporary tables and session variables can outlive a lease.
  A bridge belongs to one trusted application instance, never multiple tenants.
- Results are buffered. Transport/queue limits do not bound MariaDB execution
  memory. The engine has substantial memory and a pthread pool per open instance.
- Timeout terminates the worker. A query may already have executed; never retry
  writes automatically. Unflushed changes may be lost.

See [docs/protocol.md](docs/protocol.md) for the wire format and error behavior.

## Development and releases

```bash
npm ci --ignore-scripts
npm run test:integration
npx playwright install --with-deps chromium firefox
BRIDGE_BROWSERS=chromium,firefox npm run test:browser
npm run test:native
npm run release:package
node scripts/smoke-release.mjs
```

Native tests require PHP development headers, `phpize`, `php-config`, a C compiler,
Make and Autoconf. CI runs native PDO, real-engine, Chromium/Firefox persistence,
and standalone archive tests. See [docs/releasing.md](docs/releasing.md).

The playground may resolve the latest stable release during its build, record
its exact version/hashes, then deploy after PHP/Joomla integration tests pass.

## Licensing

Bridge source is Apache-2.0. The separately maintained MariaDB WASM dependency is
GPL-2.0-only and retains its license. Bundling does not relicense upstream code.
Release archives preserve notices and source provenance; see [NOTICE](NOTICE).

## Browser pthread limit

The bundled JavaScript uses Emscripten’s `PTHREAD_POOL_SIZE_STRICT=2` behavior:
browsers use the 16 preloaded pthread workers and return `EAGAIN` if the pool is
exhausted. MariaDB’s task pool handles that allocation failure using its existing
workers. This prevents synchronous shutdown from waiting for a new browser worker
that cannot initialize until the blocked creator returns to its event loop. Node
keeps upstream dynamic worker creation. No database binary is changed.

`npm run prepare:engine` verifies the exact upstream glue and WASM hashes before
applying the reviewed JavaScript change. The package includes patch notices and
hashes, also recorded in `bridge-manifest.json`. See [patches/NOTICE](patches/NOTICE).
A custom `engineModuleUrl` must provide an engine with equivalent browser pthread
exhaustion behavior; the unmodified lite4mariadb 0.1.2 browser module can deadlock
during shutdown. Native thread-allocation errors remain possible for workloads
that require more than the browser pool can provide.
