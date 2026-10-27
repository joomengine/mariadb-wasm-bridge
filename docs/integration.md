# Upstream PHP and Joomla integration

## Ownership

[Sean Morris's PHP WebAssembly project](https://github.com/seanmorris/php-wasm)
provides the PHP runtime, CGI request handling, virtual filesystem and extension
loader. This repository supplies the MariaDB worker, native PDO extension source,
matching extension builder and Vrzno adapter. The
[JoomEngine playground](https://github.com/joomengine/playground) assembles these
pieces, installs Joomla, routes browser requests and manages persistence.

The supported runtime packages are `php-wasm@0.2.0` and `php-cgi-wasm@0.2.0`.
`native/upstream-versions.json` pins their PHP versions, source archive hashes
and Emscripten compiler. Use the matching module for each PHP minor. Installing
this JavaScript package alone does not add a PDO driver to PHP.

## Build the native extension

Activate Emscripten 6.0.6 and install Node.js 24+, Bash, curl, xz/tar, Make,
Bison and re2c. From this repository:

```sh
npm ci --ignore-scripts
npm run prepare:engine
for minor in 8.3 8.4 8.5; do
  npm run build:upstream -- "$minor"
done
npm run test:upstream
```

For a single-version build and test:

```sh
npm run build:upstream -- 8.4
PHP_WASM_VERSIONS=8.4 npm run test:upstream
```

The outputs are `.native-build/upstream/php8.x-pdo-mariadb-wasm.so` and matching
JSON manifests. The builder configures checksum-pinned PHP headers and compiles
only this extension. It does not rebuild or modify the upstream runtime.
See [native/README.md](../native/README.md) for build overrides and ABI details.

## Connect PHP to the database

Import `createPhpWasmAdapter` from the package's `./php-wasm` export, or directly
from `adapters/php-wasm.mjs` when using the standalone layout. It returns upstream
constructor options:

- `shared.mariadbCall`: an asynchronous callback accepting a protocol JSON string.
- `files`: the bundled PHP transport, preloaded at `/internal/mariadb.php`.
- `ini`: `auto_prepend_file=/internal/mariadb.php`, which defines the transport for
  each CGI request.

Pass the adapter options to `PhpCgiWorker` and include the matching `.so` asset in
`sharedLibs`. Merge any application `files`, `shared` and `ini` options explicitly
so they do not overwrite the adapter. Forward only protocol strings across a
worker message channel: functions cannot be transferred with `postMessage`.
Create the callback inside the PHP worker. Its host implementation may call a
MariaDB bridge in that worker or forward messages to the bridge owner.

The PHP transport uses `vrzno_shared()` and `vrzno_await()` to suspend through
Asyncify until MariaDB responds. The callback must never re-enter the same PHP
runtime while it is suspended. Vrzno clears proxy state at request shutdown, so
the transport obtains the shared callback afresh for every call.

For embedded `PhpNode`/`PhpWeb` execution, explicitly require
`/internal/mariadb.php` in the script before creating PDO; `auto_prepend_file` is
used by the CGI request path. The native extension registers PDO's `mysql` driver:

```php
$db = new PDO(
    'mysql:dbname=joomla;charset=utf8mb4',
    'root',
    '',
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
);
$result = $db->query('SELECT VERSION() AS server_version')->fetch(PDO::FETCH_ASSOC);
```

Use Joomla's PDO MySQL (`mysql`) database path. The embedded engine does not
implement `mysqli`, remote networking or password authentication. Joomla should
use its supported filesystem session handler with a private persisted session
path. Its database session handler may temporarily retain a second PDO handle
during session-ID rotation; the bridge supports one native connection.

## Request boundary cleanup

**Reset the database after every settled CGI request, including successful
requests.** Framework containers and reference cycles may retain PDO objects
until a shutdown phase where their asynchronous PHP transport is no longer
available. The native destructor alone is not a sufficient request boundary.

The runtime owner must serialize request execution and cleanup together:

```js
async function handleRequest(php, database, request) {
  try {
    return await php.request(request);
  } finally {
    await database.reset();
  }
}
```

Wait for `reset()` before accepting another request. It rolls back unfinished
transactions, restores autocommit and discards the connection lease; committed
application data remains. If cleanup fails, stop the session. A reset is not a
full MySQL session reset: one bridge belongs to one trusted application instance.

A hard PHP timeout requires terminating the PHP worker before resetting or
closing its database. Never reset while PHP is still running. A database timeout
can leave uncertain write results; replace the affected session and do not replay
writes automatically. Upstream replaces its PHP instance after a non-zero exit
or fatal error. The playground must restore its application filesystem or stop
that session before continuing with the replacement runtime.

## Persistence and static hosting

Keep PHP files and MariaDB data in separate browser stores. Finish the request
and reset its database lease before flushing the stores. These checkpoints are
not an atomic transaction across both stores. Record completed installation or
recipe steps only after their required data and files are saved.

MariaDB uses threads and requires cross-origin isolation. A static deployment
must supply the required headers or a tested isolation service worker. PHP request
routing and isolation must coexist under the same service-worker scope on GitHub
Pages. The playground owns this deployment integration; the bridge does not
register a service worker.

## Validation

`npm run test:upstream` executes the compiled native driver inside the published
upstream runtime against real MariaDB. It covers prepares, exact numeric and
binary values, transactions, errors, normal/exit/fatal cleanup and a container-held
PDO connection followed by an explicit request-boundary reset.

Native PHP contract tests and browser bridge tests remain separate checks.
Complete Joomla installation, login, persistence, extension installation and JCB
compilation must be verified in the playground. Passing database tests alone does
not certify every application workflow.
