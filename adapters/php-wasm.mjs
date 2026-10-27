/** Options for the published upstream PhpCgiWorker/PhpWeb/PhpNode constructors. */
export function createPhpWasmAdapter(hostCalls, { shimUrl = new URL('./php-wasm.php', import.meta.url) } = {}) {
  if (typeof hostCalls?.['mariadb.v1'] !== 'function') {
    throw new TypeError('A mariadb.v1 host-call function is required');
  }
  return {
    shared: {
      mariadbCall: async payload => {
        if (typeof payload !== 'string') throw new TypeError('The native driver payload must be a string');
        const response = await hostCalls['mariadb.v1'](payload);
        if (typeof response !== 'string') throw new TypeError('The database response must be a string');
        return response;
      },
    },
    files: [{ parent: '/internal', name: 'mariadb.php', url: String(shimUrl) }],
    ini: 'auto_prepend_file=/internal/mariadb.php\n',
  };
}
