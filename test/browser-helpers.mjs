import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

/** Serve the actual package and installed WASM assets, without a bundler. */
export async function serve({ isolated = true } = {}) {
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (isolated) {
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    }
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname === '/') {
        response.setHeader('Content-Type', mimeTypes['.html']);
        response.end('<!doctype html><meta charset="utf-8"><title>MariaDB bridge integration test</title>');
        return;
      }
      const path = resolve(root, `.${pathname}`);
      if (!path.startsWith(`${root.replace(/\/$/, '')}${sep}`) || pathname.split('/').some(part => part.startsWith('.'))) {
        response.writeHead(403).end();
        return;
      }
      const info = await stat(path);
      if (!info.isFile()) {
        response.writeHead(404).end();
        return;
      }
      response.setHeader('Content-Type', mimeTypes[extname(path)] ?? 'application/octet-stream');
      response.setHeader('Content-Length', info.size);
      const stream = createReadStream(path);
      stream.on('error', () => response.destroy());
      stream.pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    },
  };
}

/** Functions are installed again after navigation, including persistence reloads. */
export async function installHelpers(page) {
  await page.addInitScript(() => {
    window.bridgeTest = {
      async open(options) {
        const { createMariaDB } = await import('/src/index.mjs');
        this.db = await createMariaDB(options);
        try { await this.connect(); }
        catch (error) { await this.db.close(); this.db = null; throw error; }
      },
      async call(request) {
        return JSON.parse(await this.db.hostCalls['mariadb.v1'](JSON.stringify({ version: 1, ...request })));
      },
      async success(request) {
        const response = await this.call(request);
        if (!response.ok) throw new Error(JSON.stringify(response.error));
        return response.result;
      },
      async connect() {
        const result = await this.success({ op: 'connect', database: 'joomla', user: 'root', password: '', charset: 'utf8mb4' });
        this.connection = result.connection;
        return result;
      },
      async query(sql) {
        return this.success({ op: 'query', connection: this.connection, sql });
      },
      async disconnect() {
        if (this.connection) {
          await this.success({ op: 'close', connection: this.connection });
          this.connection = null;
        }
      },
      async close() {
        try { await this.disconnect(); }
        finally {
          try { await this.db?.close(); }
          finally { this.db = null; this.connection = null; }
        }
      },
    };
  });
}
