#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
php_binary=${PHP_BIN:-php}
php_config=${PHP_CONFIG:-php-config}
compiler=${CC:-cc}
build_dir=$(mktemp -d "${TMPDIR:-/tmp}/mariadb-wasm-pdo.XXXXXXXX")
trap 'rm -rf "$build_dir"' EXIT
read -r -a includes <<< "$("$php_config" --includes)"
"$compiler" -std=c11 -shared -fPIC -O2 -Wall -Wextra -Werror -Wno-unused-parameter \
    "${includes[@]}" -DCOMPILE_DL_PDO_MARIADB_WASM=1 \
    "$root/pdo_mariadb_wasm.c" -o "$build_dir/pdo_mariadb_wasm.so"
php_options=(-n -d display_errors=stderr -d log_errors=0)
if ! "$php_binary" -n -r 'exit(extension_loaded("PDO") ? 0 : 1);'; then
    php_options+=(-d "extension=$("$php_config" --extension-dir)/pdo.so")
fi
php_options+=(-d "extension=$build_dir/pdo_mariadb_wasm.so")
"$php_binary" "${php_options[@]}" "${1:-$root/tests/contract.php}"
