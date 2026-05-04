import { Hono } from 'hono';
import { cookieOnlyAuth } from '../lib/auth.js';
import { textError } from '../lib/http.js';
import { bucket } from '../lib/core.js';

const router = new Hono();
const SAFE_MEDIA_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm', 'video/quicktime'
]);

router.get('/*', cookieOnlyAuth, async (c) => {
  // Split `/img/...` and `/video/...` requests into route base and bucket key.
  const pathParts = c.req.path.split('/');
  const routeBase = pathParts[1];
  const key = pathParts.slice(2).join('/');

  if (!key || key.includes('..') || key.includes('\\') || key.includes('\0')
    || key.startsWith('/')) return textError(c, 'Bad Request', 400);

  // Prevent direct access to internal backup objects.
  if (key.startsWith('backups/')) {
    return textError(c, 'Not Found', 404);
  }

  const obj = await bucket.get(key);
  if (!obj) return textError(c, 'Not Found', 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  const cType = String(headers.get('Content-Type') || '').toLowerCase();
  if (!SAFE_MEDIA_TYPES.has(cType)) {
    return textError(c, 'Not Found', 404);
  }

  // Enforce the expected route for each media type.
  if (routeBase === 'img' && !cType.startsWith('image/')) return textError(c, 'Not Found', 404);
  if (routeBase === 'video' && !cType.startsWith('video/')) return textError(c, 'Not Found', 404);

  headers.set('Cache-Control', 'private, max-age=31536000, immutable');
  headers.set('Vary', 'Cookie');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(obj.body, { headers });
});

export default router;
