# Native PDO driver

`pdo_mariadb_wasm` is a real C PDO driver registered under PDO's `mysql` name.
It uses the `mariadb.v1` host transport supplied by this repository. Load it into
[Sean Morris's PHP runtime](https://github.com/seanmorris/php-wasm) as a matching
WebAssembly extension, or compile it into a custom PHP build. It is incompatible
with native `pdo_mysql` because both extensions own the same driver name.

The transport invokes the existing `php_wasm_host_call()` function through
Zend's function API. The [upstream adapter](../adapters/php-wasm.php) uses Vrzno
and the runtime's existing Asyncify suspension. A JSON callback alone is insufficient to make
PDO work; the C source here supplies PDO's driver, connection and statement
methods.

## Loadable extension for upstream PHP

`native/upstream-versions.json` records the exact supported runtime and PHP source
versions. The current profile targets `php-wasm` and `php-cgi-wasm` **0.2.0**:
PHP **8.3.11**, **8.4.1** and **8.5.2**, compiled with **Emscripten 6.0.6**.
The extension uses wasm32, NTS and non-debug PHP headers. Changing runtime
versions requires rebuilding and testing the corresponding extensions.

With Emscripten 6.0.6 activated, Node.js 24+, Bash, curl, xz/tar, Make, Bison and
re2c available, build and test all supported modules:

```sh
npm ci --ignore-scripts
npm run prepare:engine
for minor in 8.3 8.4 8.5; do
  bash native/build-upstream.sh "$minor"
done
node --test native/tests/upstream.test.mjs
```

The builder downloads checksum-pinned PHP source archives, configures their
headers and compiles only this driver. It does not rebuild or patch the upstream
runtime. Outputs are `.native-build/upstream/php8.x-pdo-mariadb-wasm.so` plus a
JSON manifest containing source, compiler, runtime and output hashes. Pass an
output directory as the second argument; `BRIDGE_BUILD_CACHE` changes the source
cache directory. The tests accept `PHP_WASM_EXTENSION_DIR`, `PHP_WASM_MODULE_ROOT`
(the directory containing the installed runtime packages) and a comma-separated
`PHP_WASM_VERSIONS` selection.

Upstream's `sharedLibs` option loads the module. Install the adapter as an
`auto_prepend_file` for CGI requests and supply its `mariadbCall` JavaScript
callback. See [the integration guide](../docs/integration.md) for the complete
host setup. A PHP worker and MariaDB worker remain separate; the adapter forwards
their asynchronous host messages.

The real-engine suite verifies native PDO queries, prepares, binary and numeric
values, transactions and errors for every supported minor. CGI tests verify
native destructor cleanup and rollback on normal return, `exit(17)` and fatal
errors. Upstream replaces its PHP instance after non-zero termination; the
application must restore its filesystem or stop the session before continuing.
Always call `database.reset()` after every settled CGI request, including success.
Framework containers can retain PDO references beyond the phase where native
destruction can use the transport. Serialize this reset with the next request;
the regression suite covers a container-held PDO connection and subsequent query.

## Static integration into php-wasm

Copy this directory to `ext/pdo_mariadb_wasm` in the verified PHP source tree,
then run `./buildconf --force` before configuring PHP. Add
`--enable-pdo-mariadb-wasm` alongside `--enable-pdo`. The module depends on PDO
and JSON. Rebuild each supported PHP version and record the bridge source
release and protocol version with those engine assets. The standard
`php_pdo_mariadb_wasm.h` header makes PHP's generated static module list include
the extension.

An example application connection is:

```php
$db = new PDO(
    'mysql:host=mariadb-wasm;dbname=joomla;charset=utf8mb4',
    'root',
    '',
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
);
$statement = $db->prepare('SELECT value FROM settings WHERE name = :name');
$statement->execute(['name' => 'sitename']);
$value = $statement->fetchColumn();
```

The local endpoint aliases `localhost` and `127.0.0.1` are also accepted for
Joomla configuration. These identify the embedded engine; they never open a
network connection. Custom network ports, Unix sockets and other charsets are
rejected. The host enforces its supported user/password and connection lease.

## Supported behavior and boundaries

- PDO emulated prepares handle named and positional parameters, `bindParam`,
  `bindValue` and stream LOB input. Disabling emulated prepares is an explicit
  `HYC00` error. Text uses conventional single-quoted MySQL literals, doubling
  apostrophes and escaping backslashes/control bytes. This preserves Joomla's
  `MysqlDriver::escape()` behavior, which strips the surrounding PDO quotes.
  Binary LOB parameters use hex SQL literals.
- The host reasserts `utf8mb4` and removes `NO_BACKSLASH_ESCAPES` before every
  application query, preserving the remaining SQL modes. Applications requiring
  that mode are unsupported. This is necessary to keep PHP's emulated parameter
  parser, string escaping and MariaDB's SQL interpretation consistent.
- The bridge runs SQL against MariaDB. This driver performs no SQL dialect
  translation. Only one statement per host query is supported.
- Buffered forward-only results support all normal PDO fetch modes, NULL and
  arbitrary binary data. Integer columns become PHP integers when they fit the
  runtime's signed integer range; larger integers and DECIMAL values remain exact
  strings. FLOAT and DOUBLE become PHP floats. `PDO::ATTR_STRINGIFY_FETCHES`
  preserves numeric strings when enabled, including through constructor options.
- SQLSTATE, MariaDB error number and message are available through standard PDO
  `errorInfo()`. A statement error does not invalidate a healthy connection.
- Transactions and autocommit are real SQL commands. `inTransaction()` follows
  the host's reported server state, including implicit DDL commits.
- Column names/table metadata come from the host. `getColumnMeta()` includes
  `mariadb:type`, `mariadb:charset` and `mariadb:flags`. Missing upstream metadata
  remains missing or empty rather than being inferred from SQL text.
- `lastInsertId()` returns the host's decimal-string session `LAST_INSERT_ID()`;
  its value remains sticky until MariaDB changes it. It is not a per-statement
  success indicator. Named sequences are unsupported.
- PDO `rowCount()` and `exec()` return native PHP integers. Counts exceeding
  `PHP_INT_MAX` fail explicitly instead of overflowing on wasm32.
- Persistent PDO handles, scrollable cursors, native prepares and unimplemented
  driver attributes fail explicitly. Browser database persistence belongs to
  the bridge, not `PDO::ATTR_PERSISTENT`.
- Destruction releases the connection lease. The host must roll back unfinished
  work when closing. Killing PHP's worker can bypass PHP destruction: the
  embedding application must close or reset the database bridge on runtime
  failure before provisioning another PHP runtime.

This extension does not supply mysqli or its constants/classes. Extensions
calling mysqli directly need a separate implementation and validation.

## Native validation

On Linux install `build-essential`, `php8.3-cli` and `php8.3-dev`, then run:

```sh
PHP_BIN=php8.3 PHP_CONFIG=php-config8.3 bash native/tests/run.sh
```

The script compiles the actual C driver as a temporary native PHP extension,
loads PDO with a clean PHP configuration and runs `tests/contract.php`.
`PHP_BIN`, `PHP_CONFIG` and `CC` can select another matching toolchain. Compiler
warnings are errors; temporary binaries are removed on exit.

The contract fixture tests PDO against deterministic host messages. It is not
a substitute for the real MariaDB engine or PHP WebAssembly integration tests.
PHP 8.3 native compilation and execution are verified by this suite. The
separate upstream suite above validates PHP 8.3, 8.4 and 8.5 WASM execution.

Run the real native-driver/database integration as well:

```sh
PHP_BIN=php8.3 PHP_CONFIG=php-config8.3 node --test native/tests/database.test.mjs
```

This compiles the same C source, runs PHP natively and forwards its host calls
over a test STDIO channel to the actual MariaDB WebAssembly worker. It exercises
prepared SQL, all 256 byte values in a BLOB, UTF-8 and NUL text, exact BIGINT and
DECIMAL values, transactions and implicit commits, server error information,
and Joomla's quote-stripping idiom. The upstream suite runs the same PDO fixture
inside the published WebAssembly runtime and validates its Asyncify path.
