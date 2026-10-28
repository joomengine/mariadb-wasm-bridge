/* SPDX-License-Identifier: GPL-2.0-only
 * JoomEngine browser pthread guard for the exact lite4mariadb 0.1.2 glue.
 * Original source, modification rationale and license: see NOTICE beside this file.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const enginePatch = Object.freeze({
  id: 'browser-pthread-pool-strict-2-cpu-4',
  upstreamVersion: '0.1.2',
  upstreamSourceCommit: '24be9371a2f6c71250a2356631ad6feab2280b02',
  file: 'lite4mariadb.js',
  originalSha256: 'fdd936a38170c39b78ba573ff112212d55b1060ca6abbbefaec95791597c2132',
  wasmSha256: '1dcd5bf92685ebe37b4fc49e2fb5f57f05cef26c7e884c6ead98b2892dd59fde',
  browserPthreadPoolSize: 16,
  browserPthreadPoolSizeStrict: 2,
  browserLogicalCpuBudget: 4,
});
const hash = value => createHash('sha256').update(value).digest('hex');
const originalAllocator = 'getNewWorker(){if(PThread.unusedWorkers.length==0){var newWorker=PThread.allocateUnusedWorker();PThread.loadWasmModuleToWorker(newWorker)}return PThread.unusedWorkers.pop()}';
const strictAllocator = 'getNewWorker(){if(PThread.unusedWorkers.length==0){if(!ENVIRONMENT_IS_NODE)return;var newWorker=PThread.allocateUnusedWorker();PThread.loadWasmModuleToWorker(newWorker)}return PThread.unusedWorkers.pop()}';

export function patchEngineSource(source) {
  assert.equal(hash(source), enginePatch.originalSha256, 'Unknown upstream engine glue: review the threading patch before upgrading');
  assert.equal(source.split(originalAllocator).length, 2, 'Expected exactly one upstream pthread allocator');
  // Equivalent to Emscripten -sPTHREAD_POOL_SIZE_STRICT=2: browsers must use a
  // preloaded worker or return EAGAIN. Dynamically created browser workers need
  // the creator event loop, which synchronous native shutdown cannot service.
  // Node can start workers while the creator blocks, so retain its upstream path.
  const originalCores = 'var _emscripten_num_logical_cores=()=>ENVIRONMENT_IS_NODE?require("node:os").cpus().length:navigator["hardwareConcurrency"];';
  const boundedCores = 'var _emscripten_num_logical_cores=()=>ENVIRONMENT_IS_NODE?require("node:os").cpus().length:Math.max(1,Math.min(4,navigator["hardwareConcurrency"]||1));';
  assert.equal(source.split(originalCores).length, 2, 'Expected exactly one upstream logical-core query');
  // InnoDB targets twice this CPU count. Reserve pthread capacity for its
  // background services rather than oversubscribing the fixed browser pool.
  return '/* Modified by JoomEngine: bounded browser pthread allocation and CPU scheduling. See JOOMENGINE-NOTICE. */\n'
    + source.replace(originalAllocator, strictAllocator).replace(originalCores, boundedCores);
}


// Standalone reproduction, without npm dependencies or the bridge checkout:
// node browser-pthread-pool.mjs upstream/lite4mariadb.js prepared/lite4mariadb.js
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || path.resolve(input) === path.resolve(output)) {
    throw new Error('Usage: node browser-pthread-pool.mjs <upstream glue> <different output path>');
  }
  const patched = patchEngineSource(await readFile(input, 'utf8'));
  await writeFile(output, patched);
  console.log(`Patched glue SHA-256: ${hash(patched)}`);
}
