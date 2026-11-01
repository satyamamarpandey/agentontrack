// Serves site/ under the same base path GitHub Pages uses, so base-path mistakes fail here first.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve('site');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.json': 'application/json' };
createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!path.startsWith('/agentontrack')) { res.writeHead(404); res.end(); return; }
  let file = join(ROOT, normalize(path.slice('/agentontrack'.length)));
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404, { 'content-type': 'text/html' }); createReadStream(join(ROOT, '404.html')).pipe(res); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(4173, '127.0.0.1');
