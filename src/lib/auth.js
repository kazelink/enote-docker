import { getCookie } from 'hono/cookie';
import { verifyToken } from './jwt.js';
import { respondError } from './utils.js';

// Full auth requires the JWT (X-Auth-Token header or cookie) plus the matching session nonce header.
export async function authMiddleware(c, next) {
    const secret = process.env.JWT_SECRET;
    if (typeof secret !== 'string' || !secret) {
        return respondError(c, 'Server Not Configured', 500);
    }

    const headerToken = c.req.header('X-Auth-Token');
    const token = (headerToken && headerToken.trim()) || getCookie(c, 'enote_auth');
    const nonce = c.req.header('X-Session-Nonce');

    if (!token || !nonce) return respondError(c, 'Unauthorized', 401);

    const payload = await verifyToken(token, secret);
    if (!payload || payload.nonce !== nonce) return respondError(c, 'Unauthorized', 401);

    await next();
}

// Cookie-only auth is used for browser-native media requests that cannot attach custom headers.
export async function cookieOnlyAuth(c, next) {
    const secret = process.env.JWT_SECRET;
    if (typeof secret !== 'string' || !secret) {
        return respondError(c, 'Server Not Configured', 500);
    }

    // Use Hono's native getCookie() for safe parsing
    const token = getCookie(c, 'enote_auth');
    if (!token || !(await verifyToken(token, secret))) {
        return respondError(c, 'Unauthorized', 401);
    }

    await next();
}
