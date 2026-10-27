import type { MariaDBBridge } from './index.js';

export interface PhpWasmAdapterOptions {
  /** URL of the bundled PHP transport; defaults to adapters/php-wasm.php. */
  shimUrl?: string | URL;
}

export interface PhpWasmAdapter {
  shared: { mariadbCall(payload: string): Promise<string> };
  files: { parent: string; name: string; url: string }[];
  ini: string;
}

/**
 * Constructor options for upstream php-cgi-wasm. Load the matching native
 * extension through sharedLibs. After every settled CGI request, call reset()
 * on the database before allowing another request. For workers, create the
 * callback inside the PHP worker and forward protocol strings through RPC.
 */
export function createPhpWasmAdapter(
  hostCalls: MariaDBBridge['hostCalls'],
  options?: PhpWasmAdapterOptions,
): PhpWasmAdapter;
