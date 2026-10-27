import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
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
