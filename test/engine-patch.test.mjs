import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
const provenance = JSON.parse(await readFile(new URL('../vendor/lite4mariadb/joomengine-patches.json', import.meta.url), 'utf8'));

const upstream = await readFile(new URL('../node_modules/lite4mariadb/dist/lite4mariadb.js', import.meta.url), 'utf8');
const prepared = await readFile(new URL('../vendor/lite4mariadb/lite4mariadb.js', import.meta.url), 'utf8');
const sha256 = value => createHash('sha256').update(value).digest('hex');

test('prepared engine records immutable source, patch, compiler and artifact hashes', async () => {
  assert.equal(provenance.id, 'independent-sessions-v1');
  assert.equal(provenance.upstreamSourceCommit, '24be9371a2f6c71250a2356631ad6feab2280b02');
  assert.match(provenance.compiler, /6\.0\.6/);
  assert.equal(sha256(prepared), provenance.patchedSha256);
  const wasm = await readFile(new URL('../vendor/lite4mariadb/lite4mariadb.wasm', import.meta.url));
  assert.equal(sha256(wasm), provenance.wasmSha256);
  const exports = WebAssembly.Module.exports(new WebAssembly.Module(wasm)).map(entry => entry.name);
  for (const name of ['l4m_session_open', 'l4m_session_query', 'l4m_session_close']) assert.ok(exports.includes(name));
  const patch = await readFile(new URL('../patches/engine/independent-sessions.patch', import.meta.url));
  assert.equal(sha256(patch), provenance.patchSha256);
});

test('browser engine retains bounded native workers and CPU scheduling', () => {
  assert.equal(provenance.browserPthreadPoolSizeStrict, 2);
  const expression = prepared.match(/var _emscripten_num_logical_cores=\(\)=>(.*?);/)?.[1];
  assert.ok(expression);
  const cores = new Function('ENVIRONMENT_IS_NODE', 'navigator', 'require', `return ${expression};`);
  for (const [hardwareConcurrency, expected] of [[1, 1], [2, 2], [8, 4], [128, 4], [undefined, 1]]) {
    assert.equal(cores(false, { hardwareConcurrency }, () => { throw new Error('Unexpected Node branch'); }), expected);
  }
  assert.match(prepared, /PThread\.unusedWorkers\.length/);
});
