# Releases

The bridge has its own semantic version in `package.json` and
`package-lock.json`. Its JSON host protocol has a separate version. A bridge
release does not require a new PHP engine build to validate the MariaDB worker;
PHP applications need a PHP engine compiled with the included native PDO driver.

Before tagging, run:

```bash
npm ci --ignore-scripts
npx playwright install chromium firefox
BRIDGE_BROWSERS=chromium,firefox npm test
npm run test:native
npm run release:package
node scripts/smoke-release.mjs
```

The native test requires a C compiler, `php`, and matching `php-config` headers.
Ubuntu 24.04 CI installs `php8.3-cli`, `php8.3-dev`, and `build-essential`.
Native tests compile the actual PDO driver, check malformed-response handling
with controlled transport fixtures, and route real PDO queries through the bridge
to the actual MariaDB WASM engine. Browser tests execute that engine as well.
Neither suite on its own proves a complete Joomla installation; end-to-end PHP
WASM and Joomla testing belongs to the consuming runtime and playground builds.

The CI workflow runs the same checks on pull requests and on every release tag.
It packages only after all checks pass, then extracts the standalone archive in
a temporary directory and runs real database queries without `node_modules`.
A missing browser, native build failure, or engine startup failure fails CI.

After merging a reviewed change, update the package version and lockfile, commit
them, and push the matching tag, for example `v0.1.0`. The release workflow
rejects tags that differ from the package version. It reruns CI, downloads the
tested artifact, verifies the checksums, and creates a GitHub release containing:

- `mariadb-wasm-bridge-VERSION.tar.gz`: JavaScript bridge, TypeScript definitions,
  native PDO driver source, documentation, and the pinned MariaDB WASM assets.
- `joomengine-mariadb-wasm-bridge-VERSION.tgz`: the npm-format bridge package;
  installing it resolves the exact declared `lite4mariadb` dependency.
- `bridge-manifest.json`: source commit, bridge/protocol/engine versions, and
  SHA-256 checksums of all files in the standalone archive.
- `SHA256SUMS`: checksums of both archives and the manifest.

The workflow publishes to GitHub Releases. It does not publish to an npm
registry, and requires no npm token. The GitHub token has write permission only
in the final release job. External Actions are pinned to commit hashes.

The bridge source uses Apache-2.0. The separately bundled MariaDB engine uses
GPL-2.0-only; its upstream `COPYING` file remains beside its assets. Preserve
both license sets and notices when redistributing the bundle.

The playground may resolve this repository's latest stable release during its
own build. It should record the exact tag and manifest checksums, test that
bridge/engine/PHP/Joomla combination, and only deploy a passing build. Browser
visits should use those staged assets, without resolving mutable branches or
latest-release URLs at runtime.
