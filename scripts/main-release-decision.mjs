/** A version bump on validated main may create a new immutable release. */
export function mainReleaseDecision(tag, release, remoteTag) {
  if (release) {
    if (release.tag_name !== tag || release.prerelease) throw new Error('The release identity must be the requested stable version.');
    if (!release.draft) return 'published';
  }
  if (remoteTag || release) {
    throw new Error('An unpublished release or tag already exists. Finish that release explicitly; automatic publication never moves tags or replaces assets.');
  }
  return 'create';
}
