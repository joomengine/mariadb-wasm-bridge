#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Build a loadable PDO extension for the pinned upstream runtime, without
# rebuilding or modifying the PHP runtime itself.
set -euo pipefail

native_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
bridge_dir=$(cd -- "$native_dir/.." && pwd)
minor=${1:-8.4}
output_dir=${2:-"$bridge_dir/.native-build/upstream"}
cache_dir=${BRIDGE_BUILD_CACHE:-"$bridge_dir/.native-build/upstream"}

for command in node curl tar sha256sum emcc emconfigure make; do
  command -v "$command" >/dev/null || { printf 'Required build command is missing: %s\n' "$command" >&2; exit 1; }
done

mapfile -t pins < <(node --input-type=module - "$native_dir/upstream-versions.json" "$minor" <<'NODE'
import { readFileSync } from 'node:fs';
const pins = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const php = pins.php[process.argv[3]];
if (!php) throw new Error(`Unsupported PHP minor: ${process.argv[3]}`);
console.log([php.version, php.sha256, pins.emscriptenVersion].join('\n'));
NODE
)
[[ ${#pins[@]} == 3 ]] || { printf 'Cannot resolve upstream PHP version: %s\n' "$minor" >&2; exit 1; }
php_version=${pins[0]}
source_sha=${pins[1]}
compiler_version=${pins[2]}
[[ $(emcc -dumpversion) == "$compiler_version" ]] || { printf 'Emscripten %s is required.\n' "$compiler_version" >&2; exit 1; }

mkdir -p -- "$output_dir" "$cache_dir"
output_dir=$(cd -- "$output_dir" && pwd)
cache_dir=$(cd -- "$cache_dir" && pwd)
archive="$cache_dir/php-$php_version.tar.xz"
source_dir="$cache_dir/php-$php_version"
source_url="https://www.php.net/distributions/php-$php_version.tar.xz"

if [[ ! -f $archive ]]; then
  curl --fail --location --retry 3 --connect-timeout 30 "$source_url" -o "$archive.download"
  printf '%s  %s\n' "$source_sha" "$archive.download" | sha256sum --check --status
  mv -- "$archive.download" "$archive"
fi
printf '%s  %s\n' "$source_sha" "$archive" | sha256sum --check --status || {
  printf 'PHP source archive checksum mismatch: %s\n' "$archive" >&2; exit 1;
}

configure_args=(--disable-all --enable-pdo --enable-embed=static --disable-cli
  --disable-cgi --disable-phpdbg --disable-fiber-asm --disable-opcache-jit
  --without-pear --without-pcre-jit)
fingerprint=$(printf '%s\n' "$source_sha" "$compiler_version" "${configure_args[@]}" | sha256sum | cut -d' ' -f1)
if [[ ! -f "$source_dir/.bridge-header-fingerprint" ]] || [[ $(cat "$source_dir/.bridge-header-fingerprint") != "$fingerprint" ]]; then
  # Only this build-owned source directory is replaced; cached archives remain.
  rm -rf -- "$source_dir"
  tar --extract --xz --file "$archive" --directory "$cache_dir" --no-same-owner
  printf 'Configuring PHP %s headers for wasm32…\n' "$php_version"
  (cd -- "$source_dir" && emconfigure ./configure "${configure_args[@]}" > configure-extension.log 2>&1) || {
    tail -80 "$source_dir/configure-extension.log" >&2; exit 1;
  }
  printf '%s\n' "$fingerprint" > "$source_dir/.bridge-header-fingerprint"
fi

extension="php$minor-pdo-mariadb-wasm.so"
flags=(-O3 -flto -sSIDE_MODULE=1 -sWASM_BIGINT=1 -sASYNCIFY=1 '-sASYNCIFY_IMPORTS=*'
  -DCOMPILE_DL_PDO_MARIADB_WASM=1 -DZEND_ENABLE_STATIC_TSRMLS_CACHE=1)
includes=(-I"$source_dir" -I"$source_dir/main" -I"$source_dir/Zend"
  -I"$source_dir/TSRM" -I"$source_dir/ext" -I"$native_dir")
emcc "${flags[@]}" "${includes[@]}" "$native_dir/pdo_mariadb_wasm.c" -o "$output_dir/$extension"

node --input-type=module - "$native_dir" "$minor" "$output_dir" "$source_url" "${flags[@]}" <<'NODE'
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [native, minor, output, sourceUrl, ...flags] = process.argv.slice(2);
const pins = JSON.parse(readFileSync(join(native, 'upstream-versions.json'), 'utf8'));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const file = `php${minor}-pdo-mariadb-wasm.so`;
const manifest = {
  schemaVersion: 1,
  protocolVersion: 1,
  upstream: { repository: pins.repository, commit: pins.commit, runtimeVersion: pins.runtimeVersion },
  phpVersion: pins.php[minor].version,
  phpMinor: minor,
  emscriptenVersion: pins.emscriptenVersion,
  phpSource: { url: sourceUrl, sha256: pins.php[minor].sha256 },
  nativeSources: Object.fromEntries(['pdo_mariadb_wasm.c', 'php_pdo_mariadb_wasm.h', 'config.m4']
    .map(path => [path, hash(join(native, path))])),
  flags,
  extension: { file, sha256: hash(join(output, file)) },
};
writeFileSync(join(output, `php${minor}-pdo-mariadb-wasm.json`), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built ${join(output, file)}`);
NODE
