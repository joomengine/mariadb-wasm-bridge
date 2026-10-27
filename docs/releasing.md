# Releases

The bridge has its own semantic version in `package.json` and
`package-lock.json`. Its JSON host protocol has a separate version. A bridge
release does not require a new PHP engine build to validate the MariaDB worker.
PHP applications use the published upstream runtime and load a version-matched
native PDO extension built from the included driver source.

Version 0.1.3 is prepared in the package metadata. After its pull request is
merged, create the matching `v0.1.3` tag from that merged commit. For the next
release, prepare its newer version in a reviewed pull request before tagging:

```bash
git fetch origin --tags
npm run release:prepare -- 0.1.4
npm run check
node scripts/verify-tag.mjs v0.1.4
```

The preparation command updates the package version and both lockfile root
versions together. It requires a newer stable version and rejects a tag already
present locally. Commit those changes and merge them before tagging. If a tag
was created with inconsistent metadata, leave it intact and prepare the next
unused version instead.

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

After the version pull request passes CI and is merged, create and push its
matching tag from that merged commit, for example `v0.1.3`. The release workflow
rejects tags that differ from any package version. It reruns CI, downloads the
tested artifact, verifies the checksums, and prepares a draft GitHub release
containing:

- `mariadb-wasm-bridge-VERSION.tar.gz`: JavaScript bridge, TypeScript definitions,
  native PDO driver source, documentation, and the pinned MariaDB WASM assets.
- `joomengine-mariadb-wasm-bridge-VERSION.tgz`: the npm-format bridge package
  including the same prepared MariaDB engine, with no runtime npm dependency.
- `bridge-manifest.json`: source commit, bridge/protocol/engine versions, and
  SHA-256 checksums of all files in the standalone archive.
- `SHA256SUMS`: checksums of both archives and the manifest.

All four assets are uploaded while the release is a draft. The publisher checks
their names, sizes and GitHub-reported SHA-256 digests, verifies that the remote
tag still points to the tested source commit, and only then publishes the
release. This order supports release immutability: assets are complete before
publication locks them. A retry resumes a partial draft only when existing assets
match exactly. An already published release with the same complete asset set is
accepted without changes; mismatched or additional assets stop publication.

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

## Prepared engine provenance

The upstream `lite4mariadb` npm package is a build dependency. Engine preparation
checks its fixed JavaScript and WASM SHA-256 values, applies the documented browser
pthread exhaustion guard, and copies the unchanged binary and GPL notice into
`vendor/lite4mariadb`. Both npm and standalone archives contain exactly this
prepared engine; consumers do not run a postinstall hook. `engine.threadingPatch`
in the release manifest records the original and transformed glue hashes,
unchanged binary hash, upstream commit, and strict browser pool settings.
Changing the pinned upstream version requires reviewing and updating the transform,
then passing allocator-boundary, repeated browser-shutdown, SQL, persistence, and
release-parity tests. Do not silently copy an unreviewed engine into a release.
