<?php
/** Real compiled PDO-driver tests with a deterministic protocol fixture.
 * These establish PDO/transport behavior, not MariaDB or WebAssembly execution.
 */
declare(strict_types=1);

function check(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}
function same(mixed $expected, mixed $actual, string $message): void
{
    check($expected === $actual, "$message: expected " . var_export($expected, true) . ', got ' . var_export($actual, true));
}
function error(callable $action, string $state): PDOException
{
    try { $action(); } catch (PDOException $exception) {
        same($state, $exception->errorInfo[0] ?? (string) $exception->getCode(), 'SQLSTATE');
        return $exception;
    }
    throw new RuntimeException("Expected PDOException $state");
}
function result(array $rows = [], array $names = [], string $affected = '0', string $insertId = '0', bool $transaction = false): array
{
    return [
        'columns' => array_map(static fn(string $name): array => ['name' => $name, 'table' => 'items', 'type' => 253, 'charset' => 45, 'flags' => 0], $names),
        'rows' => array_map(static fn(array $row): array => array_map(static fn(?string $cell): ?string => $cell === null ? null : base64_encode($cell), $row), $rows),
        'affectedRows' => $affected, 'insertId' => $insertId, 'inTransaction' => $transaction,
    ];
}

$queries = [];
$expected = [];
$connected = false;
$closeCount = 0;
function expect(string $sql, array|Throwable|string $response): void
{
    $GLOBALS['expected'][] = [$sql, $response];
}
function php_wasm_host_call(string $name, string $json): string
{
    global $queries, $expected, $connected, $closeCount;
    same('mariadb.v1', $name, 'host callback name');
    $request = json_decode($json, true, 64, JSON_THROW_ON_ERROR);
    same(1, $request['version'], 'protocol version');
    if ($request['op'] === 'connect') {
        same('utf8mb4', $request['charset'], 'connection charset');
        same('root', $request['user'], 'connection user');
        same('', $request['password'], 'connection password');
        if ($connected) return json_encode(['version' => 1, 'ok' => false, 'error' => ['sqlstate' => '08004', 'errno' => 0, 'message' => 'Connection lease already owned', 'code' => 'BUSY']], JSON_THROW_ON_ERROR);
        $connected = true;
        $response = ['connection' => 'fixture-connection', 'serverVersion' => '11.4.5-MariaDB'];
    } elseif ($request['op'] === 'close') {
        same('fixture-connection', $request['connection'], 'close connection');
        $connected = false;
        $closeCount++;
        $response = [];
    } else {
        same('query', $request['op'], 'operation');
        same('fixture-connection', $request['connection'], 'query connection');
        check($connected, 'query requires active lease');
        $queries[] = $request['sql'];
        check($expected !== [], 'unexpected SQL: ' . $request['sql']);
        [$sql, $response] = array_shift($expected);
        same($sql, $request['sql'], 'SQL passed to host');
        if ($response instanceof Throwable) throw $response;
        if (is_string($response)) return $response;
        if (isset($response['error'])) return json_encode(['version' => 1, 'ok' => false] + $response, JSON_THROW_ON_ERROR);
    }
    return json_encode(['version' => 1, 'ok' => true, 'result' => $response], JSON_THROW_ON_ERROR);
}

same(['mysql'], PDO::getAvailableDrivers(), 'registered PDO driver');
$db = new PDO('mysql:host=mariadb-wasm;dbname=joomla;charset=utf8mb4', 'root', '');
same('mysql', $db->getAttribute(PDO::ATTR_DRIVER_NAME), 'driver name');
same('11.4.5-MariaDB', $db->getAttribute(PDO::ATTR_SERVER_VERSION), 'server metadata');
same(true, $db->getAttribute(PDO::ATTR_EMULATE_PREPARES), 'emulated prepares');
same("'a''b\\\\\\0\\n'", $db->quote("a'b\\\0\n"), 'MySQL text quoting');
same("X'00ff'", $db->quote("\0\xff", PDO::PARAM_LOB), 'binary quoting');
same("''", $db->quote(''), 'empty quoting');
same("a''b", substr($db->quote("a'b"), 1, -1), 'Joomla MysqlDriver escape compatibility');

expect('SELECT sample', result([["a\0b\xff", null, '9223372036854775807']], ['binary', 'nothing', 'bigint']));
$statement = $db->query('SELECT sample');
same(3, $statement->columnCount(), 'column count');
same(1, $statement->rowCount(), 'selected row count');
same('binary', $statement->getColumnMeta(0)['name'], 'column metadata before first fetch');
same(['binary' => "a\0b\xff", 'nothing' => null, 'bigint' => '9223372036854775807'], $statement->fetch(PDO::FETCH_ASSOC), 'binary/null/bigint values');
same(false, $statement->fetch(), 'result exhaustion');
same('items', $statement->getColumnMeta(0)['table'], 'column table metadata');
expect('SELECT sample', result([['changed']], ['new_column']));
$statement->execute();
same('new_column', $statement->getColumnMeta(0)['name'], 'metadata before fetch after result width changes');
same('changed', $statement->fetchColumn(), 'fetch after result width changes');
$statement->closeCursor();
same(false, $statement->fetch(), 'closed cursor');
unset($statement);

$value = "Robert'); DROP TABLE items; --";
$quoted = $db->quote($value);
expect("SELECT $quoted AS text, 42 AS number, NULL AS missing", result([[$value, '42', null]], ['text', 'number', 'missing']));
$statement = $db->prepare('SELECT :text AS text, :number AS number, :missing AS missing');
$statement->bindValue(':text', $value, PDO::PARAM_STR);
$statement->bindValue(':number', 42, PDO::PARAM_INT);
$statement->bindValue(':missing', null, PDO::PARAM_NULL);
$statement->execute();
same([$value, '42', null], $statement->fetch(PDO::FETCH_NUM), 'named parameters');
unset($statement);

$statement = $db->prepare('UPDATE items SET value=? WHERE id=?');
$value = 'first';
$id = 7;
$statement->bindParam(1, $value, PDO::PARAM_STR);
$statement->bindParam(2, $id, PDO::PARAM_INT);
expect("UPDATE items SET value='first' WHERE id=7", result([], [], '1', '17'));
$statement->execute();
same(1, $statement->rowCount(), 'affected row count');
same('17', $db->lastInsertId(), 'insert id');
$value = 'second';
$id = 9;
expect("UPDATE items SET value='second' WHERE id=9", result([], [], '2', '17'));
$statement->execute();
same(2, $statement->rowCount(), 'repeated bound references');
unset($statement);

$statement = $db->prepare('INSERT INTO items(data) VALUES (?)');
$stream = fopen('php://memory', 'r+');
fwrite($stream, "\0\xff"); rewind($stream);
$statement->bindParam(1, $stream, PDO::PARAM_LOB);
expect("INSERT INTO items(data) VALUES (X'00ff')", result([], [], '1', '18446744073709551615'));
$statement->execute();
same('18446744073709551615', $db->lastInsertId(), 'large insert id remains decimal string');
unset($statement);
if (is_resource($stream)) fclose($stream);

expect('START TRANSACTION', result([], [], '0', '17', true));
same(true, $db->beginTransaction(), 'begin transaction');
same(true, $db->inTransaction(), 'in transaction');
expect('ROLLBACK', result([], [], '0', '17', false));
same(true, $db->rollBack(), 'rollback transaction');
same(false, $db->inTransaction(), 'rollback state');
expect('START TRANSACTION', result([], [], '0', '17', true));
$db->beginTransaction();
expect('COMMIT', result());
same(true, $db->commit(), 'commit transaction');
expect('SET autocommit=0', result());
$db->setAttribute(PDO::ATTR_AUTOCOMMIT, false);
same(false, $db->getAttribute(PDO::ATTR_AUTOCOMMIT), 'autocommit disabled');
expect('SET autocommit=1', result());
$db->setAttribute(PDO::ATTR_AUTOCOMMIT, true);

expect('INSERT duplicate', ['error' => ['sqlstate' => '23000', 'errno' => 1062, 'message' => 'Duplicate entry', 'code' => 'SQL_ERROR']]);
$exception = error(fn() => $db->exec('INSERT duplicate'), '23000');
same(['23000', 1062, 'Duplicate entry'], $exception->errorInfo, 'SQL error metadata');
expect('UPDATE recovery', result([], [], '3'));
same(3, $db->exec('UPDATE recovery'), 'usable after SQL error');
same(['00000', null, null], $db->errorInfo(), 'successful operation clears error information');

$statement = $db->prepare('SELECT invalid');
expect('SELECT invalid', ['error' => ['sqlstate' => '42000', 'errno' => 1064, 'message' => 'Syntax error', 'code' => 'SQL_ERROR']]);
$exception = error(fn() => $statement->execute(), '42000');
same(['42000', 1064, 'Syntax error'], $statement->errorInfo(), 'statement SQL error metadata');
expect('SELECT invalid', result([['recovered']], ['value']));
$statement->execute();
same('recovered', $statement->fetchColumn(), 'statement recovery');
same(['00000', null, null], $statement->errorInfo(), 'statement clears error metadata');
unset($statement);

expect('SELECT transport_error', new RuntimeException('Host failed'));
$exception = error(fn() => $db->query('SELECT transport_error'), 'HY000');
check(str_contains($exception->getMessage(), 'Host failed'), 'host failure becomes PDO error');
expect('SELECT transport_error_class', new Error('Host Error failed'));
$exception = error(fn() => $db->query('SELECT transport_error_class'), 'HY000');
check(str_contains($exception->getMessage(), 'Host Error failed'), 'Error message survives transport conversion');
expect('SELECT malformed', '{"version":1,"ok":true,"result":{"rows":[]}}');
error(fn() => $db->query('SELECT malformed'), 'HY000');
expect('SELECT malformed_json', '{');
error(fn() => $db->query('SELECT malformed_json'), 'HY000');
$bad = result([['x']], ['one']);
$bad['rows'][0][0] = '!not base64!';
expect('SELECT malformed_binary', $bad);
error(fn() => $db->query('SELECT malformed_binary'), 'HY000');
expect('UPDATE overflow', result([], [], '18446744073709551615'));
error(fn() => $db->exec('UPDATE overflow'), 'HY000');
error(fn() => $db->setAttribute(PDO::ATTR_EMULATE_PREPARES, false), 'HYC00');
error(fn() => $db->getAttribute(PDO::ATTR_TIMEOUT), 'IM001');
error(fn() => $db->lastInsertId('sequence'), 'HYC00');
error(fn() => $db->prepare('SELECT 1', [PDO::ATTR_CURSOR => PDO::CURSOR_SCROLL]), 'HYC00');
error(fn() => new PDO('mysql:host=remote;dbname=joomla'), 'HYC00');
error(fn() => new PDO('mysql:charset=latin1;dbname=joomla'), 'HYC00');
error(fn() => new PDO('mysql:dbname=joomla', 'root', '', [PDO::ATTR_PERSISTENT => true]), 'HYC00');
error(fn() => new PDO('mysql:dbname=joomla', 'root', '', [PDO::ATTR_EMULATE_PREPARES => false]), 'HYC00');
error(fn() => new PDO('mysql:dbname=joomla', 'root', ''), '08004');

unset($exception, $db);
gc_collect_cycles();
same(false, $connected, 'PDO destructor releases bridge lease');
same(1, $closeCount, 'close runs exactly once');
same([], $expected, 'all host interactions occurred');
echo "Native PDO contract: PASS (prepared statements, binary results, transactions, errors, metadata, lifecycle)\n";
