import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { compareVersions, stableVersion } from './release-version.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.length !== 3) throw new Error('Usage: npm run release:prepare -- <stable-version>');
const version = stableVersion(process.argv[2]);
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
if (!lock.packages?.['']) throw new Error('package-lock.json is missing its root package entry.');
for (const current of [pkg.version, lock.version, lock.packages[''].version]) {
  if (compareVersions(version, current) < 0) throw new Error(`The new version must not be lower than ${current}.`);
}
const tag = `v${version}`;
const found = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], { cwd: root });
if (found.error) throw found.error;
if (found.status === 0) throw new Error(`${tag} already exists. Choose the next unused stable version.`);
if (found.status !== 1) throw new Error(`Cannot inspect existing tags: ${found.stderr.toString().trim()}`);
pkg.version = version;
lock.version = version;
lock.packages[''].version = version;
await writeFile(path.join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
await writeFile(path.join(root, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
console.log(`Prepared ${tag}. Commit and merge these version files, then create the tag from that commit.`);
