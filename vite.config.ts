import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

const MIME: Record<string, string> = {
  '.ini': 'text/plain; charset=utf-8',
  '.vmp': 'application/octet-stream',
  '.vmc': 'application/octet-stream',
  '.vpr': 'application/octet-stream',
  '.pal': 'application/octet-stream',
};

/**
 * Serves `<VANGERS_DATA>` read-only under `/@data/...` in both dev and preview,
 * so the viewer can auto-load a world without copying 20+ MB files around.
 */
function vangersData(): Plugin {
  const handler = (req: any, res: any, next: () => void) => {
    const root = process.env.VANGERS_DATA;
    if (!root) return next();
    const rel = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, '');
    const resolved = path.resolve(root, rel);
    if (!resolved.startsWith(path.resolve(root))) {
      res.statusCode = 403;
      return res.end('Forbidden');
    }
    fs.stat(resolved, (err, stat) => {
      if (err || !stat.isFile()) {
        res.statusCode = 404;
        return res.end('Not found');
      }
      res.setHeader('Content-Type', MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Content-Length', stat.size);
      fs.createReadStream(resolved).pipe(res);
    });
  };

  return {
    name: 'vangers-data',
    configureServer(server) {
      server.middlewares.use('/@data', handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/@data', handler);
    },
  };
}

export default defineConfig({
  plugins: [react(), vangersData()],
  server: { port: 5173 },
  preview: { port: 4173 },
});
