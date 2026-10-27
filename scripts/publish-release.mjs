import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { verifyRelease } from './verify-release.mjs';
import { hashFile, releaseDir, root, run } from './release-utils.mjs';
import { readReleaseIdentity, verifyTag } from './release-version.mjs';
import { checkReleaseAssets } from './release-assets.mjs';

const identity = await readReleaseIdentity(root);
verifyTag(identity, process.env.GITHUB_REF_NAME);
const { manifest } = await verifyRelease();
const sourceCommit = run('git', ['rev-parse', 'HEAD']).trim();
if (run('git', ['status', '--porcelain', '--untracked-files=all']).trim()) {
  throw new Error('Publishing requires a clean checkout of the tagged commit.');
}
if (manifest.sourceCommit !== sourceCommit || (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sourceCommit)) {
  throw new Error('The release bundle must come from this exact tagged commit.');
}
const files = await Promise.all((await readdir(releaseDir)).sort().map(async name => ({
  name, bytes: await readFile(path.join(releaseDir, name)),
  sha256: (await hashFile(path.join(releaseDir, name))).sha256,
})));
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || !token) {
  throw new Error('Publishing requires GITHUB_REPOSITORY and GH_TOKEN.');
}

async function request(endpoint, { method = 'GET', body, allowMissing = false } = {}) {
  const response = await fetch(`https://api.github.com/repos/${repository}${endpoint}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(180_000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (allowMissing && response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub release ${method} failed: HTTP ${response.status}.`);
  return response.json();
}

async function verifyRemoteTag() {
  let { object } = await request(`/git/ref/tags/${identity.tag}`);
  for (let depth = 0; object.type === 'tag' && depth < 5; depth++) {
    ({ object } = await request(`/git/tags/${object.sha}`));
  }
  if (object.type !== 'commit' || object.sha !== sourceCommit) {
    throw new Error('The remote release tag must still point to the exact tested source commit.');
  }
}

async function findRelease() {
  const published = await request(`/releases/tags/${identity.tag}`, { allowMissing: true });
  if (published) return published;
  // The tag lookup is for published releases; drafts require the authenticated list.
  for (let page = 1; ; page++) {
    const releases = await request(`/releases?per_page=100&page=${page}`);
    const matches = releases.filter(release => release.tag_name === identity.tag);
    if (matches.length > 1) throw new Error('Multiple drafts use this release tag; resolve them before publishing.');
    if (matches.length) return matches[0];
    if (releases.length < 100) return null;
  }
}

await verifyRemoteTag();
let release = await findRelease();
if (release?.prerelease) throw new Error('A stable version must use a stable release.');
if (release && !release.draft) {
  checkReleaseAssets(files, release, { complete: true });
  console.log(`${identity.tag} is already published with these verified assets.`);
} else {
  if (!release) release = await request('/releases', { method: 'POST', body: {
    tag_name: identity.tag, name: `MariaDB WASM Bridge ${identity.tag}`,
    target_commitish: sourceCommit, draft: true, prerelease: false, generate_release_notes: true,
  } });
  for (const file of checkReleaseAssets(files, release)) {
    const upload = new URL(`https://uploads.github.com/repos/${repository}/releases/${release.id}/assets`);
    upload.searchParams.set('name', file.name);
    const response = await fetch(upload, { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(180_000), headers: { Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json', 'Content-Type': 'application/octet-stream',
        'X-GitHub-Api-Version': '2022-11-28' }, body: file.bytes });
    if (!response.ok) throw new Error(`Uploading ${file.name} failed: HTTP ${response.status}; the release remains a draft.`);
    checkReleaseAssets([file], { assets: [await response.json()] }, { complete: true });
  }
  release = await request(`/releases/${release.id}`);
  if (!release.draft) throw new Error('Release state changed during asset upload.');
  checkReleaseAssets(files, release, { complete: true });
  await verifyRemoteTag();
  release = await request(`/releases/${release.id}`, { method: 'PATCH', body: { draft: false } });
  if (release.draft) throw new Error('GitHub did not publish the verified release.');
  console.log(`Published ${identity.tag} with all verified assets${release.immutable ? ' and immutable release protection' : ''}.`);
}
