<?php
/** Native PDO -> protocol -> real MariaDB WASM. No SQL responses are mocked. */
declare(strict_types=1);
function php_wasm_host_call(string $name, string $payload): string {
    echo json_encode(['type'=>'host','name'=>$name,'payload'=>$payload], JSON_THROW_ON_ERROR), "\n";
    fflush(STDOUT);
    $line=fgets(STDIN);
    if ($line===false) throw new RuntimeException('Host disconnected');
    $response=json_decode($line,true,64,JSON_THROW_ON_ERROR);
    if(isset($response['error'])) throw new RuntimeException($response['error']);
    return $response['value'];
}
require __DIR__ . '/database-contract.php';
