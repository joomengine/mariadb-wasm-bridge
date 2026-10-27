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
same('1',$db->query('SELECT COUNT(*) AS total FROM bridge_pdo')->fetchColumn(),'rollback');
$db->beginTransaction();
$db->exec("INSERT INTO bridge_pdo(label) VALUES ('committed')");
$db->commit();
same('2',$db->query('SELECT COUNT(*) AS total FROM bridge_pdo')->fetchColumn(),'commit');
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
same('2',$db->query('SELECT COUNT(*) AS total FROM bridge_pdo')->fetchColumn(),'error recovery');
$db->exec("SET sql_mode='NO_BACKSLASH_ESCAPES'");
$statement=$db->prepare('UPDATE bridge_pdo SET label=:text WHERE id=:id');
$statement->execute(['text'=>"quoted' \\ text",'id'=>'1']);
same("quoted' \\ text",$db->query('SELECT label FROM bridge_pdo WHERE id=1')->fetchColumn(),'host restores quote mode');
unset($statement);
$value="Joomla's \\ escaped value";
$escaped=substr($db->quote($value),1,-1);
$db->exec("UPDATE bridge_pdo SET label='$escaped' WHERE id=1");
same($value,$db->query('SELECT label FROM bridge_pdo WHERE id=1')->fetchColumn(),'Joomla escape idiom');
same(['1','2',null,"\0\xff"],$db->query("SELECT 1 AS ordering, 2 AS ordering, NULL AS ordering, X'00ff' AS ordering")->fetch(PDO::FETCH_NUM),'duplicate columns preserve positions');
same(['ordering'=>'2'],$db->query('SELECT 1 AS ordering, 2 AS ordering')->fetch(PDO::FETCH_ASSOC),'PDO associative duplicate semantics');
same(['ordering'=>['1','2']],$db->query('SELECT 1 AS ordering, 2 AS ordering')->fetch(PDO::FETCH_NAMED),'PDO named duplicate semantics');
same([],$db->query('SELECT 1 AS ordering, 2 AS ordering WHERE 0')->fetchAll(PDO::FETCH_NUM),'empty duplicate result');
$db->exec('DROP TABLE implicit_commit');
$db->exec('DROP TABLE bridge_pdo');
unset($exception,$db);
gc_collect_cycles();
echo json_encode(['type'=>'complete','assertions'=>$assertions],JSON_THROW_ON_ERROR),"\n";
