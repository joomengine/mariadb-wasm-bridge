import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const buildRoot = path.join(root, '.native-build/engine');
const source = process.env.ENGINE_SOURCE_DIR ?? path.join(buildRoot, 'source');
const commit = '24be9371a2f6c71250a2356631ad6feab2280b02';
const hash = value => createHash('sha256').update(value).digest('hex');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
  return result.stdout?.trim();
}
await mkdir(buildRoot, { recursive: true });
if (!process.env.ENGINE_SOURCE_DIR) {
  try { await access(path.join(source, '.git')); }
  catch {
    run('git', ['clone', '--no-checkout', 'https://github.com/shyim/lite4mariadb.git', source]);
    run('git', ['-C', source, 'checkout', '--detach', commit]);
  }
}
assert.equal(run('git', ['-C', source, 'rev-parse', 'HEAD'], { stdio: 'pipe' }), commit);
run('git', ['-C', source, 'submodule', 'update', '--init', '--depth', '1', 'libmariadb', 'extra/wolfssl/wolfssl']);
const patch = path.join(root, 'patches/engine/independent-sessions.patch');
const alreadyApplied = spawnSync('git', ['-C', source, 'apply', '--reverse', '--check', patch], { stdio: 'ignore' }).status === 0;
if (!alreadyApplied) {
  run('git', ['-C', source, 'apply', '--check', patch]);
  run('git', ['-C', source, 'apply', patch]);
}
assert.equal(run('git', ['-C', source, 'diff', '--full-index', '--', 'wasm/lite4mariadb.c', 'wasm/CMakeLists.txt', 'mysys/get_password.c', 'storage/innobase/log/log0log.cc', 'storage/innobase/buf/buf0flu.cc'], { stdio: 'pipe' }), (await readFile(patch, 'utf8')).trim(), 'Source modifications differ from the reviewed patch');
run('bash', ['wasm/build.sh'], { cwd: source, env: {
  ...process.env, JOBS: process.env.JOBS ?? '4',
  NATIVE_BUILD: path.join(buildRoot, 'native'), WASM_BUILD: path.join(buildRoot, 'wasm'),
} });
const dist = path.join(buildRoot, 'dist');
await mkdir(dist, { recursive: true });
await cp(path.join(source, 'wasm/dist'), dist, { recursive: true });
const gluePath = path.join(dist, 'lite4mariadb.js');
let glue = await readFile(gluePath, 'utf8');
const cores = 'var _emscripten_num_logical_cores=()=>ENVIRONMENT_IS_NODE?require("node:os").cpus().length:navigator["hardwareConcurrency"];';
assert.equal(glue.split(cores).length, 2, 'Review the engine CPU scheduling adapter after a toolchain update');
glue = glue.replace(cores, 'var _emscripten_num_logical_cores=()=>Math.max(1,Math.min(4,ENVIRONMENT_IS_NODE?require("node:os").cpus().length:navigator["hardwareConcurrency"]||1));');
await writeFile(gluePath, glue);
const compiler = run('emcc', ['--version'], { stdio: 'pipe' }).split('\n')[0];
assert.match(compiler, /6\.0\.6/);
const provenance = {
  id: 'independent-sessions-v1', upstreamVersion: '0.1.2', upstreamSourceCommit: commit,
  patchSha256: hash(await readFile(patch)), compiler,
  browserPthreadPoolSize: 16, browserPthreadPoolSizeStrict: 2, browserLogicalCpuBudget: 4, nodeLogicalCpuBudget: 4,
  patchedSha256: hash(glue), wasmSha256: hash(await readFile(path.join(dist, 'lite4mariadb.wasm'))),
};
await writeFile(path.join(dist, 'joomengine-patches.json'), `${JSON.stringify(provenance, null, 2)}\n`);
console.log('Built independent MariaDB sessions with verified source and compiler provenance.');
