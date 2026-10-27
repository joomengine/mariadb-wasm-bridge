/** Reject changed uploads; an unfinished draft may only be completed with matching files. */
export function checkReleaseAssets(files, release, { complete = false } = {}) {
  const expected = new Map(files.map(file => [file.name, file]));
  for (const asset of release.assets || []) {
    const file = expected.get(asset.name);
    if (!file || asset.state !== 'uploaded' || asset.digest !== `sha256:${file.sha256}` || asset.size !== file.bytes.length) {
      throw new Error(`Existing release asset differs from the tested build: ${asset.name}.`);
    }
    expected.delete(asset.name);
  }
  if (complete && expected.size) throw new Error(`Release assets are missing: ${[...expected.keys()].join(', ')}.`);
  return [...expected.values()];
}
