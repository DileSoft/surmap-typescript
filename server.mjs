// Minimal static file server (no dependencies).
// Usage: node server.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // Optional: allow serving the Vangers data directory read-only:
  //   /@data/thechain/fostral/output.vmc  ->  <VANGERS>\data\thechain\fostral\output.vmc
  const dataRoot = process.env.VANGERS_DATA;
  let filePath;
  if (urlPath.startsWith('/@data/')) {
    if (!dataRoot) {
      res.writeHead(404).end('VANGERS_DATA env var not set');
      return;
    }
    filePath = path.join(dataRoot, urlPath.slice('/@data/'.length));
  } else {
    filePath = path.join(__dirname, urlPath);
  }

  const resolved = path.resolve(filePath);
  const allowed = dataRoot ? [path.resolve(__dirname), path.resolve(dataRoot)] : [path.resolve(__dirname)];
  if (!allowed.some((root) => resolved.startsWith(root))) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(resolved, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404).end('Not found');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(resolved).pipe(res);
  });
});

server.listen(port, () => {
  console.log(`surmap-typescript serving ${__dirname}`);
  console.log(`  http://localhost:${port}/`);
  if (process.env.VANGERS_DATA) {
    console.log(`  data: http://localhost:${port}/@data/  (${process.env.VANGERS_DATA})`);
  }
});
