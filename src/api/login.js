import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import crypto from 'node:crypto';
import { CONFIG } from '../lib/config.js';
import { signToken } from '../lib/jwt.js';
import { ensureSchema } from '../lib/schema.js';
import { respondError } from '../lib/utils.js';

const router = new Hono();

const loginLimits = new Map();

function getLimit(ip) {
  const record = loginLimits.get(ip);
  if (!record) return null;

  if (Date.now() - record.lastFailAt > CONFIG.LOGIN.LOCK_MS) {
    loginLimits.delete(ip);
    return null;
  }
  return record;
}

function recordFail(ip, now) {
  const record = loginLimits.get(ip) || { count: 0, lockedUntil: 0, lastFailAt: 0 };
  record.count += 1;
  record.lastFailAt = now;
  if (record.count >= CONFIG.LOGIN.MAX_ATTEMPTS) {
    record.lockedUntil = now + CONFIG.LOGIN.LOCK_MS;
  }
  loginLimits.set(ip, record);
  return record.lockedUntil;
}

function clearLimit(ip) {
  loginLimits.delete(ip);
}

async function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();
  const[hashA, hashB] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b))
  ]);
  const valueA = new Uint8Array(hashA);
  const valueB = new Uint8Array(hashB);
  let result = 0;
  for (let i = 0; i < valueA.length; i += 1) result |= valueA[i] ^ valueB[i];
  return result === 0;
}

function lockedResponse(c, lockedUntil, now) {
  const waitSec = Math.ceil((lockedUntil - now) / 1000);
  c.header('Retry-After', String(waitSec));
  return respondError(c, `Locked. Retry in ${waitSec}s`, 429);
}

router.post('/', async (c) => {
  const ip = c.req.header('X-Real-IP')
    || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown';
  const now = Date.now();

  const record = getLimit(ip);
  if (record && record.lockedUntil > now) {
    return lockedResponse(c, record.lockedUntil, now);
  }

  let body = {};
  try {
    const contentType = c.req.header('content-type') || '';
    if (contentType.includes('form')) body = await c.req.parseBody();
    else body = await c.req.json();
  } catch {
    return respondError(c, 'Invalid Request', 400);
  }

  if (typeof body.password !== 'string' || !body.password.trim()) {
    return respondError(c, 'Password Required', 400);
  }
  if (!process.env.APP_PASSWORD || !process.env.JWT_SECRET) {
    return respondError(c, 'Server Not Configured', 500);
  }

  if (!(await timingSafeEqual(body.password, process.env.APP_PASSWORD))) {
    const lockedUntil = recordFail(ip, now);
    if (lockedUntil > now) {
      return lockedResponse(c, lockedUntil, now);
    }
    return respondError(c, 'Wrong password', 401);
  }

  clearLimit(ip);

  try {
    const nonceBytes = new Uint8Array(16);
    crypto.getRandomValues(nonceBytes);
    const nonce = [...nonceBytes].map(b => b.toString(16).padStart(2, '0')).join('');

    const token = await signToken(process.env.JWT_SECRET, nonce);
    
    await ensureSchema().catch(err => console.error('ensureSchema error after login:', err));
    
    setCookie(c, 'enote_auth', token, {
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
      maxAge: 7 * 24 * 60 * 60
    });

    if (c.req.header('HX-Request')) {
      c.header('HX-Trigger', JSON.stringify({ loginSuccess: { nonce } }));
      return c.html('<div class="auth-ok"></div>');
    }
    return c.json({ success: true, nonce });
  } catch {
    return respondError(c, 'Crypto Error', 500);
  }
});

export default router;