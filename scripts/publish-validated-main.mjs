import { verifyRelease } from './verify-release.mjs';
import { root, run } from './release-utils.mjs';
import { readReleaseIdentity } from './release-version.mjs';
import { mainReleaseDecision } from './main-release-decision.mjs';

if (process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF !== 'refs/heads/main') {
  throw new Error('Automatic publication requires a validated main-branch push.');
}
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || !token) {
  throw new Error('Publishing requires GITHUB_REPOSITORY and GH_TOKEN.');
}
const identity = await readReleaseIdentity(root);
const sourceCommit = run('git', ['rev-parse', 'HEAD']).trim();
const { manifest } = await verifyRelease();
if (manifest.sourceCommit !== sourceCommit || process.env.GITHUB_SHA !== sourceCommit
  || run('git', ['status', '--porcelain', '--untracked-files=all']).trim()) {
  throw new Error('Automatic publication requires the verified artifact from this exact clean main commit.');
}

async function request(endpoint, { method = 'GET', body, allowMissing = false } = {}) {
  const response = await fetch(`https://api.github.com/repos/${repository}${endpoint}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (allowMissing && response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub publication ${method} failed: HTTP ${response.status}.`);
  return response.json();
}

let release = await request(`/releases/tags/${identity.tag}`, { allowMissing: true });
if (!release) {
  for (let page = 1; ; page++) {
    const releases = await request(`/releases?per_page=100&page=${page}`);
    const matches = releases.filter(candidate => candidate.tag_name === identity.tag);
    if (matches.length > 1) throw new Error('Multiple drafts use this release tag.');
    if (matches.length) { [release] = matches; break; }
    if (releases.length < 100) break;
  }
}
const remoteTag = await request(`/git/ref/tags/${identity.tag}`, { allowMissing: true });
if (mainReleaseDecision(identity.tag, release, remoteTag) === 'published') {
  console.log(`${identity.tag} is already published; this merge does not request another release.`);
} else {
  // Never force-update a ref. A competing tag creation fails safely here.
  await request('/git/refs', { method: 'POST', body: { ref: `refs/tags/${identity.tag}`, sha: sourceCommit } });
  // The existing publisher verifies that tag and every asset before publication.
  // GITHUB_TOKEN-created tags intentionally do not trigger a second build.
  process.env.GITHUB_REF_NAME = identity.tag;
  await import('./publish-release.mjs');
}
