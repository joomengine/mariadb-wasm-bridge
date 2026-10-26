PHP_ARG_ENABLE([pdo-mariadb-wasm], [whether to enable the MariaDB WASM PDO driver],
  [AS_HELP_STRING([--enable-pdo-mariadb-wasm], [Build the MariaDB WASM PDO driver])], [no])

if test "$PHP_PDO_MARIADB_WASM" != "no"; then
  PHP_NEW_EXTENSION([pdo_mariadb_wasm], [pdo_mariadb_wasm.c], [$ext_shared])
  PHP_ADD_EXTENSION_DEP([pdo_mariadb_wasm], [pdo])
  PHP_ADD_EXTENSION_DEP([pdo_mariadb_wasm], [json])
fi
