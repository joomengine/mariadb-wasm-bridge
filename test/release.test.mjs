import { mainReleaseDecision } from '../scripts/main-release-decision.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { compareVersions, readReleaseIdentity, stableVersion, verifyTag } from '../scripts/release-version.mjs';
import { checkReleaseAssets } from '../scripts/release-assets.mjs';

test('release tags require the prepared stable package version', () => {
  assert.throws(() => verifyTag({ version: '0.1.1', tag: 'v0.1.1' }, 'v0.1.2'), /Prepare and merge/);
  assert.doesNotThrow(() => verifyTag({ version: '0.1.3', tag: 'v0.1.3' }, 'v0.1.3'));
  for (const version of ['v0.1.3', '01.2.3', '1.2.3-beta', '1.2.3\n', '1.2.9007199254740992']) {
    assert.throws(() => stableVersion(version), /stable semantic version/);
  }
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.9.9', '1.0.0'), -1);
});

test('release metadata checks both lockfile root versions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-release-'));
  try {
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '0.1.3' }));
    const lock = { version: '0.1.3', packages: { '': { version: '0.1.3' } } };
    await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify(lock));
    assert.equal((await readReleaseIdentity(directory)).tag, 'v0.1.3');
    for (const invalid of [
      { ...lock, version: '0.1.2' },
      { ...lock, packages: { '': { version: '0.1.2' } } },
    ]) {
      await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify(invalid));
      await assert.rejects(readReleaseIdentity(directory), /must match/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('release upload verification rejects changed assets and resumes matching drafts', () => {
  const first = { name: 'bridge.tar.gz', bytes: Buffer.from('archive'), sha256: 'a'.repeat(64) };
  const second = { name: 'SHA256SUMS', bytes: Buffer.from('checksums'), sha256: 'b'.repeat(64) };
  const asset = file => ({ name: file.name, state: 'uploaded', digest: `sha256:${file.sha256}`, size: file.bytes.length });
  assert.deepEqual(checkReleaseAssets([first, second], { assets: [asset(first)] }), [second]);
  assert.deepEqual(checkReleaseAssets([first, second], { assets: [asset(first), asset(second)] }, { complete: true }), []);
  assert.throws(() => checkReleaseAssets([first, second], { assets: [asset(first)] }, { complete: true }), /missing/);
  for (const invalid of [
    { ...asset(first), digest: `sha256:${'c'.repeat(64)}` },
    { ...asset(first), size: 0 },
    { ...asset(first), state: 'starter' },
    { ...asset(first), name: 'extra.zip' },
  ]) assert.throws(() => checkReleaseAssets([first], { assets: [invalid] }), /differs/);
  assert.throws(() => checkReleaseAssets([first], { assets: [asset(first), asset(first)] }), /differs/);
});

test('release preparation repairs manual bumps and rejects downgrades and existing tags', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-prepare-'));
  try {
    await mkdir(path.join(directory, 'scripts'));
    for (const name of ['prepare-version.mjs', 'release-version.mjs']) {
      await writeFile(path.join(directory, 'scripts', name), await readFile(new URL(`../scripts/${name}`, import.meta.url)));
    }
    const git = (...args) => spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(git('init').status, 0);
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '0.1.4' }));
    await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({ version: '0.1.3', packages: { '': { version: '0.1.3' }, dependency: { version: '1.0.0' } } }));
    const prepare = version => spawnSync(process.execPath, ['scripts/prepare-version.mjs', version], { cwd: directory, encoding: 'utf8' });
    assert.equal(prepare('0.1.4').status, 0);
    assert.equal((await readReleaseIdentity(directory)).version, '0.1.4');
    assert.notEqual(prepare('0.1.3').status, 0);
    assert.equal(git('add', '.').status, 0);
    assert.equal(git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture').status, 0);
    assert.equal(git('tag', 'v0.1.4').status, 0);
    assert.notEqual(prepare('0.1.4').status, 0);
    // Recover the exact failed-release state while moving to the next version.
    const lock = JSON.parse(await readFile(path.join(directory, 'package-lock.json'), 'utf8'));
    lock.version = lock.packages[''].version = '0.1.3';
    await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify(lock));
    assert.equal(prepare('0.1.5').status, 0);
    const identity = await readReleaseIdentity(directory);
    assert.equal(identity.version, '0.1.5');
    assert.equal(identity.lock.packages.dependency.version, '1.0.0');
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('validated main only creates new stable tags and never replaces an existing release', () => {
  const tag = 'v0.1.6';
  assert.equal(mainReleaseDecision(tag, null, null), 'create');
  assert.equal(mainReleaseDecision(tag, {tag_name:tag, draft:false, prerelease:false}, {object:{sha:'old-commit'}}), 'published');
  assert.throws(() => mainReleaseDecision(tag, null, {object:{sha:'different-commit'}}), /unpublished/);
  assert.throws(() => mainReleaseDecision(tag, null, {object:{sha:'same-commit'}}), /unpublished/);
  assert.throws(() => mainReleaseDecision(tag, {tag_name:tag, draft:true}, null), /unpublished/);
  assert.throws(() => mainReleaseDecision(tag, {tag_name:tag, draft:false, prerelease:true}, null), /stable version/);
  assert.throws(() => mainReleaseDecision(tag, {tag_name:'v0.1.5', draft:false}, null), /stable version/);
});
