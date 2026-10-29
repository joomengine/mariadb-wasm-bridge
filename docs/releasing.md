# Releases

The bridge has its own semantic version in `package.json` and
`package-lock.json`. Its JSON host protocol has a separate version. A bridge
release does not require a new PHP engine build to validate the MariaDB worker.
PHP applications use the published upstream runtime and load a version-matched
native PDO extension built from the included driver source.

Use the Node.js version in [.node-version](../.node-version) for local validation
and release preparation. CI uses the same exact version for every Node job.

Prepare a release with one command (using the next unused stable version):

```bash
git fetch origin --tags
npm run release:prepare -- 0.1.5
npm run check
node scripts/verify-tag.mjs v0.1.5
```

The preparation command updates `package.json` and both lockfile root versions
together. If you already edited `package.json`, run it with that same version to
synchronize the lockfile. It also repairs mismatched metadata when preparing a
newer version, rejects downgrades, and rejects tags already present locally.
Commit those changes and merge them before tagging. If a tag was created with
inconsistent metadata, leave it intact and prepare the next unused version instead.

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
matching tag from that merged commit, for example `v0.1.5`. The release workflow
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

The engine job rebuilds lite4mariadb from immutable source using the reviewed
independent-session patch and pinned Emscripten 6.0.6. Its verified output is
cached by source/patch/compiler configuration, then used by native, browser and
release validation. `engine.threadingPatch` records the source commit, patch
hash, compiler identity, generated JavaScript and WASM hashes, and strict worker
pool settings. The archive includes the complete patch, build recipe and source
link with the GPL notices. Consumers use the already built release assets.
Changing an input requires passing session/transaction isolation, retained PDO,
repeated browser shutdown, SQL, persistence and release-parity tests.

## Publication from validated main

A merged stable package-version bump publishes automatically after both main CI
validation jobs succeed. The publication job consumes the exact tested release
artifact, checks its source commit, creates the new version tag without force,
and uses the existing draft-upload/verification publisher. A version that is
already published is skipped. Conflicting tags or unfinished releases fail
explicitly and require the existing tag-release workflow to be completed; they
are never moved or overwritten. Main runs are not cancelled midway through
publication, while superseded pull-request checks still cancel normally.

Tags created with the workflow token intentionally do not start another build.
Manual tag publication and recovery remain available by running the Release
workflow against the existing version tag. Running it against main fails the
tag identity check before publication.
