import { fileURLToPath } from 'node:url';
import { readReleaseIdentity, verifyTag } from './release-version.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const identity = await readReleaseIdentity(root);
verifyTag(identity, process.env.GITHUB_REF_NAME || process.argv[2]);
console.log(`Verified release identity ${identity.tag}.`);
