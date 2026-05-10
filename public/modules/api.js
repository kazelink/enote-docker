import { UI } from './ui.js';

let memNonce = null;

// 必须保留此对象，否则 auth.js 里的 Nonce.set 会报错导致死循环
export const Nonce = {
    get() { 
        try { return sessionStorage.getItem('session_nonce') || memNonce; } 
        catch(e) { return memNonce; } 
    },
    set(val) { 
        memNonce = val; 
        try { sessionStorage.setItem('session_nonce', val); } catch(e) {} 
    },
    clear() { 
        memNonce = null; 
        try { sessionStorage.removeItem('session_nonce'); } catch(e) {} 
    }
};

export function authHeaders(extra = {}) {
    const nonce = Nonce.get();
    return nonce ? { 'X-Session-Nonce': nonce, ...extra } : { ...extra };
}

function buildApiUrl(endpoint, data = {}) {
    const base = endpoint.startsWith('/api/') ? endpoint : `/api/${endpoint}`;
    const params = new URLSearchParams(
        Object.entries(data).filter(([_, value]) => value != null && value !== '')
    );
    return params.toString() ? `${base}?${params.toString()}` : base;
}

async function handleUnauthorized(res, payload) {
    if (res.status !== 401) return;
    Nonce.clear();
    UI.showAuth();
    const err = new Error(payload?.error || 'Unauthorized');
    err.code = 'UNAUTHORIZED';
    err.status = 401;
    throw err;
}

export const API = {
    async checkAuth() {
        const res = await fetch('/api/auth-status', { headers: authHeaders(), credentials: 'include', cache: 'no-store' });
        return res.ok;
    },

    async req(endpoint, data = {}, method = 'GET') {
        const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
        const url = buildApiUrl(endpoint, hasBody ? {} : data);
        const headers = authHeaders();
        let body = undefined;

        if (hasBody) {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(data);
        }

        const res = await fetch(url, { method, headers, body, credentials: 'include', cache: 'no-store' });
        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        let payload = null;

        if (contentType.includes('application/json')) {
            payload = await res.json().catch(() => null);
        } else {
            const text = await res.text().catch(() => '');
            payload = text ? { error: text } : null;
        }

        await handleUnauthorized(res, payload);

        if (!res.ok) {
            const err = new Error(payload?.error || `API Error (${res.status})`);
            err.code = 'API_ERROR';
            err.status = res.status;
            throw err;
        }

        return payload ?? {};
    },

    async html(endpoint, data = {}) {
        const url = buildApiUrl(endpoint, data);
        const res = await fetch(url, {
            headers: authHeaders({ 'HX-Request': 'true' }),
            credentials: 'include',
            cache: 'no-store'
        });
        const text = await res.text().catch(() => '');
        await handleUnauthorized(res, { error: text });

        if (!res.ok) {
            const err = new Error(text || `HTML Error (${res.status})`);
            err.code = 'API_ERROR';
            err.status = res.status;
            throw err;
        }

        return text;
    }
};