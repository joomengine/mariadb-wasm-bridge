# PHP and Joomla integration

## Ownership

This repository releases JavaScript database integration, browser engine assets,
and native PDO driver **source**. `php-wasm` owns compiling PHP and this driver
statically into its versioned engines. The playground owns Joomla installation,
extension recipes, request routing and browser isolation.

The native extension uses Zend to call the PHP runtime's already exposed
`php_wasm_host_call()` function. It needs no extra Emscripten syscall or native
socket library. PHP-WASM's Asyncify host transport suspends until the database
worker resolves the request. Host callbacks must never call back into the same
PHP runtime.

## Static build changes in php-wasm

For each PHP source tree:

1. Obtain a verified bridge source release and copy the files from `native/`
   into PHP's `ext/pdo_mariadb_wasm/` directory.
2. Regenerate configure using PHP's `./buildconf --force` after adding the extension.
3. Keep `--enable-pdo` and add `--enable-pdo-mariadb-wasm` to the PHP configuration.
4. Do not enable another driver registering PDO's `mysql` name in the same engine.
5. Build through the existing Asyncify toolchain and record the bridge release
   version and protocol version in runtime metadata.
6. Run native PHP-WASM execution tests against this database worker, then test
   Joomla 5/6 installation and the selected extension packages in the playground.

These changes belong to a follow-up PHP runtime integration. This repository does
not mutate the PHP runtime's current branch or promise dynamic `.so` loading in
WebAssembly. Native shared-module compilation exists solely for development tests.

## Runtime contract

Create the database first, then create PHP with the bridge's host handlers. The
PHP engine must list `mysql` in `PDO::getAvailableDrivers()` before installing Joomla.
Use Joomla's PDO MySQL (`mysql`) database path, not its `mysqli` path. The normal
connection is `mysql:dbname=joomla;charset=utf8mb4`, root, empty password. Credentials
are for the embedded local engine; this is not a remote production database.

Keep one bridge per PHP/application instance. PHP request/module state is rebuilt
between invocations, while database state remains in its worker. PDO handle
cleanup releases the lease and rolls back an open transaction. If PHP execution
is killed before cleanup, call `database.reset()` after the PHP runtime stops.
After a database timeout, replace both affected runtime/session owners instead
of reusing stale PDO handles.

A playground checkpoint must explicitly flush both stores: first finish PHP work
and close PDO handles, then `database.flush()` and `php.flush()`. These are separate
stores and are not an atomic cross-store transaction. Record successful recipe
steps only when their required data and files have been saved.

## Current validation boundary

The native test suite compiles the actual C PDO module. Contract fixtures test
malformed protocol responses and PDO behavior. A separate subprocess harness
routes the real driver's calls to real MariaDB WASM and verifies SQL/bindings,
transactions, values and error propagation. Browser tests exercise actual WASM
in Chromium and Firefox including IndexedDB reloads and cross-tab locks.

The combined native driver inside PHP-WASM, real Joomla installation and JCB
compilation remain downstream integration checks. Successful bridge tests alone
must not be labeled end-to-end Joomla compatibility.
