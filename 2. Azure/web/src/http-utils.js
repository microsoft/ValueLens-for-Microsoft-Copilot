export function applySecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', [
    "frame-ancestors 'self' https://teams.microsoft.com https://*.teams.microsoft.com https://*.cloud.microsoft https://*.office.com https://outlook.office.com",
    "default-src 'self'",
    "connect-src 'self' https://login.microsoftonline.com",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' https://res.cdn.office.net",
    "frame-src https://login.microsoftonline.com"
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

export function sendJson(res, status, body, headers = {}) {
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('Request body is too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('Request body must be valid JSON');
    error.statusCode = 400;
    throw error;
  }
}
