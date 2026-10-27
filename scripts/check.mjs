import { access, readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkg.version)) {
  throw new Error('package.json must contain a stable semantic version');
}
if (lock.version !== pkg.version || lock.packages[''].version !== pkg.version) {
  throw new Error('package-lock.json version differs from package.json');
}
const engineVersion = pkg.devDependencies.lite4mariadb;
if (!/^\d+\.\d+\.\d+$/.test(engineVersion) || lock.packages['node_modules/lite4mariadb'].version !== engineVersion) {
  throw new Error('The MariaDB engine must use one exact, lockfile-verified version');
}
for (const entry of Object.values(pkg.exports)) {
  for (const file of Object.values(entry)) await access(path.join(root, file));
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(name));
    else files.push(name);
  }
  return files;
}
for (const directory of ['src', 'scripts', 'test', 'patches', 'adapters', 'native/tests']) {
  for (const file of await walk(path.join(root, directory))) {
    if (!/\.(?:mjs|js)$/.test(file)) continue;
    if (spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' }).status !== 0) {
      throw new Error(`JavaScript syntax check failed: ${file}`);
    }
  }
}
for (const file of await walk(path.join(root, '.github'))) {
  if (!/\.ya?ml$/.test(file)) continue;
  const document = parseDocument(await readFile(file, 'utf8'), { uniqueKeys: true });
  if (document.errors.length) throw new Error(`${file}: ${document.errors.map(e => e.message).join('; ')}`);
  if (!file.includes(`${path.sep}workflows${path.sep}`)) continue;
  for (const job of Object.values(document.toJS().jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (step.uses && !step.uses.startsWith('./') && !/@[a-f0-9]{40}$/.test(step.uses)) {
        throw new Error(`${file}: pin external Actions to full commit SHAs`);
      }
    }
  }
}
console.log('JavaScript syntax, workflow YAML, action pins, and package versions are valid.');
