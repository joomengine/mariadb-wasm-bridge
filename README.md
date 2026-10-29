# MariaDB WASM Bridge

A versioned MariaDB WebAssembly bridge and native PDO extension for
[Sean Morris’s PHP WASM runtime](https://github.com/seanmorris/php-wasm). SQL executes in
real MariaDB through [lite4mariadb](https://github.com/shyim/lite4mariadb), without
SQLite translation, an external database service or a Docker runtime.

## Upstream foundations and credits

This integration builds on the work of these projects and their maintainers:

- **[seanmorris/php-wasm](https://github.com/seanmorris/php-wasm)** — Sean Morris
  and contributors provide the PHP WebAssembly runtime, browser and CGI execution,
  filesystem, Vrzno integration and native extension loading used by the playground.
- **[emscripten-core/emscripten](https://github.com/emscripten-core/emscripten)** —
  The Emscripten maintainers and contributors provide the compiler, JavaScript
  integration, virtual filesystem and Asyncify support used by these WASM modules.
- **[shyim/lite4mariadb](https://github.com/shyim/lite4mariadb)** — Provides the real
  MariaDB WebAssembly engine bundled by this bridge.

Thank you to these communities for the engineering and maintenance that make this
project possible. Upstream licenses and notices remain included in our releases.

## Implementation status

This initial implementation supplies a dedicated database worker, the versioned
`mariadb.v1` host protocol, browser persistence, native PDO driver source, and
real-engine tests. It registers PDO's `mysql` driver name so Joomla can use its
normal PDO MySQL database path.

**The native driver loads into the published upstream runtime as a separate WASM
extension.** The build profile targets `php-wasm` and `php-cgi-wasm` 0.2.0 with
PHP 8.3.11, 8.4.1 and 8.5.2. No PHP runtime fork is required. Installing this
JavaScript package alone does not compile or load that driver; see
[the integration guide](docs/integration.md) for the builder, adapter and lifecycle.
The [playground](https://github.com/joomengine/playground) assembles the browser
application and validates Joomla workflows.

## Use from JavaScript

The package supports Node.js 24+, while development and CI use Node.js 26.12.1
from [.node-version](.node-version) to avoid the known
[Node.js 24.x shared-WASM lifecycle crash](https://github.com/nodejs/node/issues/66366).
Clone this repository and run `npm ci`. Build the pinned engine with
`node scripts/build-engine.mjs` using Emscripten 6.0.6, CMake, Bison and native
MariaDB build prerequisites. Then run `npm run prepare:engine`. CI caches the
source-matched engine; tests and packaging verify its provenance before staging.
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

Use `createPhpWasmAdapter(database.hostCalls)` from the `./php-wasm` package export
with upstream PHP and load the matching `pdo_mariadb_wasm` extension. PHP then uses
`new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '')`. The PHP worker must
finish each CGI request before the bridge owner calls `database.reset()`; wait
for that cleanup before accepting another request, even after successful PHP
execution. See [docs/integration.md](docs/integration.md).

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

- Each PDO owns a separate embedded MariaDB connection (up to 32). Transactions,
  temporary tables and session variables are independent. Closing or resetting
  connections rolls back unfinished work and discards their session state.
  A bridge belongs to one trusted application instance, never multiple tenants.
- PDO emulated prepares are supported. Native server-side prepares, `mysqli`,
  networking and password authentication are not implemented. The embedded engine
  accepts root or an empty username with an empty password.
- Connections default to `utf8mb4`; `utf8mb3` and its `utf8` alias negotiate three-byte UTF-8. Binary/NUL values survive transport. PDO returns
  in-range integers and floating types as PHP numbers; out-of-range integers
  and DECIMAL values remain exact strings. `PDO::ATTR_STRINGIFY_FETCHES` is supported.
- The bridge disables `NO_BACKSLASH_ESCAPES` before each query so PDO and Joomla
  text quoting stay consistent. Other SQL mode flags are preserved.
- BIT and GEOMETRY results require an explicit SQL cast to a supported numeric,
  text or binary type; upstream otherwise risks corrupting their bytes.
- One SQL statement is accepted per call. Duplicate result-column names retain
  every positional value; the decoder preserves native JSON member order.
- Column names and MariaDB type/charset/flags are available; source table names
  are unavailable and returned empty.
- `lastInsertId()` uses session `LAST_INSERT_ID()`, retained until another insert
  or reset. It is not a per-statement native getter. Internal metadata queries
  also change diagnostic SQL state such as `ROW_COUNT()` and warnings.
- Results are buffered. Transport/queue limits do not bound MariaDB execution
  memory. The engine has substantial memory and a pthread pool per open instance.
- Timeout terminates the worker. A query may already have executed; never retry
  writes automatically. Unflushed changes may be lost.

See [docs/protocol.md](docs/protocol.md) for the wire format and error behavior.

## Development and releases

```bash
npm ci --ignore-scripts
node scripts/build-engine.mjs
npm run test:integration
npx playwright install --with-deps chromium firefox
BRIDGE_BROWSERS=chromium,firefox npm run test:browser
npm run test:native
for minor in 8.3 8.4 8.5; do npm run build:upstream -- "$minor"; done
npm run test:upstream
npm run release:package
node scripts/smoke-release.mjs
```

Native tests require PHP development headers, `phpize`, `php-config`, a C compiler,
Make and Autoconf. WASM extension builds require Emscripten 6.0.6, Bison and re2c.
CI runs native PDO, upstream PHP-WASM PDO, real-engine, Chromium/Firefox persistence,
and standalone archive tests. See [docs/releasing.md](docs/releasing.md).

The playground may resolve the latest stable release during its build, record
its exact version/hashes, then deploy after PHP/Joomla integration tests pass.

## Licensing

Bridge source is Apache-2.0. The separately maintained MariaDB WASM dependency is
GPL-2.0-only and retains its license. Bundling does not relicense upstream code.
Release archives preserve notices and source provenance; see [NOTICE](NOTICE).

## Engine sessions, capacity and scheduling

The bundled engine is rebuilt from the immutable lite4mariadb 0.1.2 source with
[the reviewed session patch](patches/engine/independent-sessions.patch). Its new
C entry points open, query and close independent embedded MariaDB connections.
The public host-call protocol and native PHP PDO module remain unchanged.

The InnoDB buffer pool starts at 64 MiB and may be resized up to 256 MiB; the
server packet limit is 128 MiB. Default JSON transport limits are 32 MiB per
request, 64 MiB per response and 128 MiB across accepted queued requests.
These are separate budgets, not a total database-size cap or a promise that a
128 MiB row fits in a single PHP query. Results are buffered and base64 encoded,
so large values should use bounded batches or chunks. The WASM heap can grow to
2 GiB, including engine structures and data pages; browser storage quota and
PHP's separate memory budget also apply.

When InnoDB waits for a redo checkpoint, the WebAssembly build yields before
retrying. This lets background checkpoint writes acquire the shared latch and
complete proxied filesystem operations. MariaDB retains its transaction and
durability semantics.

The engine preloads 16 pthread workers; browsers return `EAGAIN` when this pool
is exhausted. Logical CPU scheduling is capped at four in both browsers and
Node to keep MariaDB background concurrency bounded. Node may still allocate
additional workers under Emscripten scheduling rules. Row and metadata lock
waits default to five seconds so a
second synchronous session reports a normal SQL timeout before the bridge
operation deadline. Build provenance records the upstream source, patch hash,
compiler identity and both generated asset hashes. `npm run prepare:engine`
verifies that record before staging, and release archives include the patch,
reproduction script and GPL notices. See [patches/NOTICE](patches/NOTICE).
