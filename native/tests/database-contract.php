<?php
/** PDO contract shared by native and WebAssembly integration tests. */
declare(strict_types=1);
$assertions=0;
function same(mixed $expected,mixed $actual,string $message):void {
    $GLOBALS['assertions']++;
    if($expected!==$actual) throw new RuntimeException($message.': '.var_export($actual,true));
}
$db=new PDO('mysql:host=mariadb-wasm;dbname=joomla;charset=utf8mb4','root','',[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
same(true,str_contains($db->getAttribute(PDO::ATTR_SERVER_VERSION),'MariaDB'),'real server');
$db->exec('CREATE TABLE bridge_pdo (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, label VARCHAR(255) CHARACTER SET utf8mb4, payload LONGBLOB, big BIGINT UNSIGNED, amount DECIMAL(24,6), nullable VARCHAR(10) NULL) ENGINE=InnoDB');
$text="Namibia 🐘 ' \\ \0 ; -- ? :parameter";
$binary=implode('',array_map(chr(...),range(0,255)));
$statement=$db->prepare('INSERT INTO bridge_pdo (label,payload,big,amount,nullable) VALUES (:label,:payload,:big,:amount,:nullable)');
$statement->bindValue(':label',$text,PDO::PARAM_STR);
$statement->bindValue(':payload',$binary,PDO::PARAM_LOB);
$statement->bindValue(':big','18446744073709551615',PDO::PARAM_STR);
$statement->bindValue(':amount','123456789012345678.123456',PDO::PARAM_STR);
$statement->bindValue(':nullable',null,PDO::PARAM_NULL);
$statement->execute();
same(1,$statement->rowCount(),'insert count');
same('1',$db->lastInsertId(),'insert id');
unset($statement);
$statement=$db->prepare('SELECT label,payload,big,amount,nullable FROM bridge_pdo WHERE id=?');
$statement->bindValue(1,1,PDO::PARAM_INT);
$statement->execute();
same(5,$statement->columnCount(),'columns');
same([$text,$binary,'18446744073709551615','123456789012345678.123456',null],$statement->fetch(PDO::FETCH_NUM),'lossless result');
same(false,$statement->fetch(),'exhausted');
same('label',$statement->getColumnMeta(0)['name'],'metadata');
$statement->closeCursor();
unset($statement);
$db->beginTransaction();
same(true,$db->inTransaction(),'transaction');
$db->exec("INSERT INTO bridge_pdo(label) VALUES ('rolled back')");
$db->rollBack();
same(false,$db->inTransaction(),'rollback state');
same(1,$db->query('SELECT COUNT(*) AS total FROM bridge_pdo')->fetchColumn(),'rollback');
$db->beginTransaction();
$db->exec("INSERT INTO bridge_pdo(label) VALUES ('committed')");
$db->commit();
same(2,$db->query('SELECT COUNT(*) AS total FROM bridge_pdo')->fetchColumn(),'commit');
$db->beginTransaction();
$db->exec('CREATE TABLE implicit_commit (id INT) ENGINE=InnoDB');
same(false,$db->inTransaction(),'DDL commit');
try {
    $db->exec("INSERT INTO bridge_pdo(id,label) VALUES (1,'duplicate')");
    throw new RuntimeException('Expected duplicate key error');
} catch(PDOException $exception) {
    same('23000',$exception->errorInfo[0],'SQLSTATE');
    same(1062,$exception->errorInfo[1],'errno');
}
same(2,$db->query('SELECT COUNT(*) AS total FROM bridge_pdo')->fetchColumn(),'error recovery');
$db->exec("SET sql_mode='NO_BACKSLASH_ESCAPES'");
$statement=$db->prepare('UPDATE bridge_pdo SET label=:text WHERE id=:id');
$statement->execute(['text'=>"quoted' \\ text",'id'=>'1']);
same("quoted' \\ text",$db->query('SELECT label FROM bridge_pdo WHERE id=1')->fetchColumn(),'host restores quote mode');
unset($statement);
$value="Joomla's \\ escaped value";
$escaped=substr($db->quote($value),1,-1);
$db->exec("UPDATE bridge_pdo SET label='$escaped' WHERE id=1");
same($value,$db->query('SELECT label FROM bridge_pdo WHERE id=1')->fetchColumn(),'Joomla escape idiom');
same([1,2,null,"\0\xff"],$db->query("SELECT 1 AS ordering, 2 AS ordering, NULL AS ordering, X'00ff' AS ordering")->fetch(PDO::FETCH_NUM),'duplicate columns preserve positions');
same(['ordering'=>2],$db->query('SELECT 1 AS ordering, 2 AS ordering')->fetch(PDO::FETCH_ASSOC),'PDO associative duplicate semantics');
same(['ordering'=>[1,2]],$db->query('SELECT 1 AS ordering, 2 AS ordering')->fetch(PDO::FETCH_NAMED),'PDO named duplicate semantics');
same([],$db->query('SELECT 1 AS ordering, 2 AS ordering WHERE 0')->fetchAll(PDO::FETCH_NUM),'empty duplicate result');
same(false,$db->getAttribute(PDO::ATTR_STRINGIFY_FETCHES),'native numeric fetch default');
$db->exec('CREATE TABLE bridge_numeric (tiny TINYINT, small SMALLINT, medium MEDIUMINT, normal INT, unsigned32 INT UNSIGNED, positive BIGINT, negative BIGINT, signed_max BIGINT, signed_min BIGINT, huge BIGINT UNSIGNED, amount DECIMAL(24,6), approximate FLOAT, precise DOUBLE, year_value YEAR, numeric_text VARCHAR(20), absent INT) ENGINE=InnoDB');
$db->exec("INSERT INTO bridge_numeric VALUES (-128,-32768,-8388608,-2147483648,4294967295,2147483647,-2147483649,9223372036854775807,-9223372036854775808,18446744073709551615,123456789012345678.123456,1.25,-150,2026,'00123',NULL)");
$expectedNumeric=[-128,-32768,-8388608,PHP_INT_SIZE===4?PHP_INT_MIN:-2147483648,
    PHP_INT_SIZE===8?4294967295:'4294967295',2147483647,
    PHP_INT_SIZE===8?-2147483649:'-2147483649',
    PHP_INT_SIZE===8?PHP_INT_MAX:'9223372036854775807',
    PHP_INT_SIZE===8?PHP_INT_MIN:'-9223372036854775808',
    '18446744073709551615','123456789012345678.123456',1.25,-150.0,2026,'00123',null];
same($expectedNumeric,$db->query('SELECT * FROM bridge_numeric')->fetch(PDO::FETCH_NUM),'SQL numeric types and native integer bounds');
$numericStatement=$db->query('SELECT normal,amount FROM bridge_numeric');
same(PDO::PARAM_INT,$numericStatement->getColumnMeta(0)['pdo_type'],'integer column metadata');
same(PDO::PARAM_STR,$numericStatement->getColumnMeta(1)['pdo_type'],'decimal column metadata');
unset($numericStatement);
$db->setAttribute(PDO::ATTR_STRINGIFY_FETCHES,true);
same(true,$db->getAttribute(PDO::ATTR_STRINGIFY_FETCHES),'stringify enabled');
same(['-32768','1.25','-150',null],$db->query('SELECT small,approximate,precise,absent FROM bridge_numeric')->fetch(PDO::FETCH_NUM),'stringify retains numeric text and null');
$db->setAttribute(PDO::ATTR_STRINGIFY_FETCHES,false);
same(12,$db->query('SELECT CAST(12 AS SIGNED) AS id')->fetchObject()->id,'application integer primary key');
$db->exec('DROP TABLE bridge_numeric');
$db->exec('DROP TABLE implicit_commit');
$db->exec('DROP TABLE bridge_pdo');
unset($exception,$db);
gc_collect_cycles();
$db=new PDO('mysql:dbname=joomla','root','',[PDO::ATTR_STRINGIFY_FETCHES=>true]);
same('42',$db->query('SELECT 42')->fetchColumn(),'constructor stringify option');
unset($db);
foreach (['utf8' => 'utf8mb3', 'utf8mb3' => 'utf8mb3', 'utf8mb4' => 'utf8mb4'] as $requested => $negotiated) {
    $db = new PDO('mysql:dbname=joomla;charset=' . $requested, 'root', '', [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    same($negotiated, $db->query('SELECT @@character_set_connection')->fetchColumn(), 'negotiated PDO charset');
    same('café 中文', $db->query("SELECT 'café 中文'")->fetchColumn(), 'UTF-8 PDO round trip');
    unset($db);
}
// A retained, closed cursor keeps its PDO alive after the application disconnects.
// Reconnection must not steal that connection's variables or transaction.
$db = new PDO('mysql:dbname=joomla', 'root', '');
$db->exec('CREATE TABLE retained_session_rows (id INT PRIMARY KEY) ENGINE=InnoDB');
$db->exec('SET @retained_owner=41');
$db->beginTransaction();
$db->exec('INSERT INTO retained_session_rows VALUES (1)');
$retained = $db->query('SELECT @retained_owner');
same(41, $retained->fetchColumn(), 'original session variable');
$retained->closeCursor();
unset($db);
$replacement = new PDO('mysql:dbname=joomla', 'root', '');
same(null, $replacement->query('SELECT @retained_owner')->fetchColumn(), 'replacement has independent variables');
same(0, $replacement->query('SELECT COUNT(*) FROM retained_session_rows')->fetchColumn(), 'replacement cannot see unfinished transaction');
$replacement->exec('SET @retained_owner=42');
$retained->execute();
same(41, $retained->fetchColumn(), 'retained statement can execute on original session');
unset($retained);
same(42, $replacement->query('SELECT @retained_owner')->fetchColumn(), 'closing original does not reset replacement');
same(0, $replacement->query('SELECT COUNT(*) FROM retained_session_rows')->fetchColumn(), 'closing original rolls back its transaction');
$replacement->exec('DROP TABLE retained_session_rows');
unset($replacement);
echo json_encode(['type'=>'complete','assertions'=>$assertions],JSON_THROW_ON_ERROR),"\n";
