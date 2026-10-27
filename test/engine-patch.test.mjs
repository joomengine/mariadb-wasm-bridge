import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { enginePatch, patchEngineSource } from '../scripts/prepare-engine.mjs';

const upstream = await readFile(new URL('../node_modules/lite4mariadb/dist/lite4mariadb.js', import.meta.url), 'utf8');
const prepared = await readFile(new URL('../vendor/lite4mariadb/lite4mariadb.js', import.meta.url), 'utf8');
const sha256 = value => createHash('sha256').update(value).digest('hex');

test('engine preparation accepts only the reviewed upstream glue and preserves the binary', async () => {
  assert.equal(sha256(upstream), enginePatch.originalSha256, 'The installed upstream dependency must stay unmodified');
  assert.equal(prepared, patchEngineSource(upstream));
  assert.throws(() => patchEngineSource(`${upstream}\n`), /Unknown upstream engine glue/);
  assert.throws(() => patchEngineSource(prepared), /Unknown upstream engine glue/);
  const wasm = await readFile(new URL('../vendor/lite4mariadb/lite4mariadb.wasm', import.meta.url));
  const originalWasm = await readFile(new URL('../node_modules/lite4mariadb/dist/lite4mariadb.wasm', import.meta.url));
  assert.equal(sha256(wasm), enginePatch.wasmSha256);
  assert.deepEqual(wasm, originalWasm);
});

test('the actual prepared allocator bounds browsers and retains Node worker creation', () => {
  const [allocator] = prepared.match(/getNewWorker\(\)\{if\(PThread\.unusedWorkers\.length==0\).*?return PThread\.unusedWorkers\.pop\(\)\}/) ?? [];
  assert.ok(allocator, 'Prepared runtime must contain the reviewed allocator');
  // Execute the allocator extracted from the distributed engine. No SQL or
  // database responses are substituted; this isolates its exhaustion boundary.
  const allocate = new Function('PThread', 'ENVIRONMENT_IS_NODE', `return ({${allocator}}).getNewWorker();`);
  const preloaded = { loaded: true };
  let allocated = 0;
  let loaded = 0;
  const pool = {
    unusedWorkers: [preloaded],
    allocateUnusedWorker() { allocated++; const worker = {}; this.unusedWorkers.push(worker); return worker; },
    loadWasmModuleToWorker(worker) { loaded++; worker.loaded = true; },
  };
  assert.equal(allocate(pool, false), preloaded);
  assert.equal(allocate(pool, false), undefined, 'Browser exhaustion must report EAGAIN through spawnThread');
  assert.equal(allocated, 0, 'No unloaded browser worker can be created while native code is blocked');
  assert.equal(loaded, 0);
  assert.deepEqual(allocate(pool, true), { loaded: true });
  assert.equal(allocated, 1, 'Node retains supported dynamic worker creation');
  assert.equal(loaded, 1);
});
