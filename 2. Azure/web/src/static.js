import fs from 'node:fs/promises';
import path from 'node:path';

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.png', 'image/png'], ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'], ['.woff', 'font/woff'], ['.woff2', 'font/woff2']
]);

export function createStaticHandler(publicDir) {
  const root = path.resolve(publicDir);
  return async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let filePath = safeResolve(root, pathname === '/' ? '/index.html' : pathname);
    if (!filePath) return false;
    let stat = await statOrNull(filePath);
    const acceptsHtml = String(req.headers.accept || '').includes('text/html');
    if ((!stat || !stat.isFile()) && acceptsHtml && !pathname.startsWith('/api/')) {
      filePath = path.join(root, 'index.html');
      stat = await statOrNull(filePath);
    }
    if (!stat || !stat.isFile()) return false;
    const ext = path.extname(filePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME_TYPES.get(ext) || 'application/octet-stream');
    if (pathname.startsWith('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    else if (path.basename(filePath) === 'index.html') res.setHeader('Cache-Control', 'no-cache');
    if (req.method === 'HEAD') return res.end();
    res.end(await fs.readFile(filePath));
    return true;
  };
}

function safeResolve(root, requestPath) {
  let decoded;
  try { decoded = decodeURIComponent(requestPath); } catch { return null; }
  const resolved = path.resolve(root, decoded.replace(/^\/+/, ''));
  return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null;
}
async function statOrNull(filePath) { try { return await fs.stat(filePath); } catch { return null; } }
