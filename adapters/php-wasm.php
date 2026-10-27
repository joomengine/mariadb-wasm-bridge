<?php
/** Connect the native PDO driver to an upstream php-wasm JavaScript callback. */
declare(strict_types=1);

function php_wasm_host_call(string $name, string $payload): string
{
    if ($name !== 'mariadb.v1') {
        throw new InvalidArgumentException('Unsupported database host protocol: ' . $name);
    }

    // Acquire the callback for each request: Vrzno clears proxies at shutdown.
    return vrzno_await((vrzno_shared('mariadbCall'))($payload));
}
