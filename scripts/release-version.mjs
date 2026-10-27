import { readFile } from 'node:fs/promises';
import path from 'node:path';

export function stableVersion(value) {
  if (typeof value !== 'string' || value.length > 64 || value.trim() !== value
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
    || value.split('.').some(part => BigInt(part) > BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new TypeError('Use a stable semantic version such as 0.1.3.');
  }
  return value;
}

export function compareVersions(left, right) {
  const a = stableVersion(left).split('.').map(BigInt);
  const b = stableVersion(right).split('.').map(BigInt);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export async function readReleaseIdentity(directory) {
  const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(directory, 'package-lock.json'), 'utf8'));
  const version = stableVersion(pkg.version);
  if (lock.version !== version || lock.packages?.['']?.version !== version) {
    throw new Error('package.json and both root package-lock.json versions must match.');
  }
  return { version, tag: `v${version}`, pkg, lock };
}

export function verifyTag(identity, tag) {
  if (tag !== identity.tag) {
    throw new Error(`Release tag ${tag || '(missing)'} does not match package version ${identity.version}. Prepare and merge the version change before creating ${identity.tag}; existing tags are not rewritten.`);
  }
}
