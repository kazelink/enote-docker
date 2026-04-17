const ESC_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '`': '&#x60;'
};

const ESC_RE = /[&<>"'`]/g;

const ENTITY_MAP = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&#x60;': '`'
};

export const escapeHtml = (str) =>
    str == null ? '' : String(str).replace(ESC_RE, (char) => ESC_MAP[char] || char);

export function respondError(c, msg, status) {
    if (c.req.header('HX-Request')) return c.html(`<div class="auth-err">${msg}</div>`, status);
    return c.json({ error: msg }, status);
}

function normalizeInlineText(value, maxLen) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.slice(0, maxLen);
}

export function normalizeTitle(value, maxLen = 120) {
    return normalizeInlineText(value, maxLen);
}

export function normalizeFolderName(value, maxLen = 60) {
    return normalizeInlineText(value, maxLen);
}

export function normalizeTagList(input, { maxTags = 12, maxLen = 24 } = {}) {
    const source = Array.isArray(input)
        ? input
        : String(input || '').split(/[,\n，]+/);

    const tags = [];
    const seen = new Set();

    for (const raw of source) {
        const normalized = normalizeInlineText(raw, maxLen);
        if (!normalized) continue;

        const key = normalized.toLowerCase();
        if (seen.has(key)) continue;

        seen.add(key);
        tags.push(normalized);
        if (tags.length >= maxTags) break;
    }

    return tags;
}

export function parseStoredTags(raw) {
    if (Array.isArray(raw)) return normalizeTagList(raw);
    if (typeof raw !== 'string' || !raw.trim()) return [];

    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return normalizeTagList(parsed);
    } catch {
        // Fall back to splitting plain text tag strings.
    }

    return normalizeTagList(raw);
}

export function serializeTags(tags) {
    return JSON.stringify(normalizeTagList(tags));
}

export function normalizeTimestamp(value, fallback = '') {
    const ts = Date.parse(String(value || ''));
    if (!Number.isFinite(ts)) return fallback;
    return new Date(ts).toISOString();
}

function decodeBasicEntities(text) {
    let out = String(text || '');
    for (const [entity, value] of Object.entries(ENTITY_MAP)) {
        out = out.split(entity).join(value);
    }
    return out;
}

function stripHtmlTags(html) {
    return decodeBasicEntities(
        String(html || '')
            .replace(/<br\s*\/?>/gi, ' ')
            .replace(/<\/(p|div|h1|h2|h3|blockquote|li)>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
    ).replace(/\s+/g, ' ').trim();
}

function excerptTextFromHtml(html, maxLen = 120) {
    const text = stripHtmlTags(html);
    if (!text) return '';
    return text.length <= maxLen ? text : `${text.slice(0, maxLen).trim()}...`;
}

export function deriveImportedTitle(content) {
    return excerptTextFromHtml(content, 80) || 'Imported Note';
}

const MEDIA_TAG_RE = /<(?:img|video)\b[^>]*>/gi;
const LOCAL_MEDIA_SRC_RE = /\bsrc\s*=\s*(["']?)\/(?:img|video)\/([^"'\s>]+)\1/i;
const PROTECTED_PREFIXES = ['backups/'];

const isProtectedKey = (key) =>
    PROTECTED_PREFIXES.some((prefix) => String(key || '').startsWith(prefix));

async function filterUnusedMediaKeys(db, keys) {
    if (!db || !Array.isArray(keys) || keys.length === 0) return keys;

    const queries = keys.map((key) =>
        db.prepare(`
            SELECT 1 AS used
            FROM notes
            WHERE instr(content, ?) > 0 OR instr(content, ?) > 0
            LIMIT 1
        `).bind(`/img/${key}`, `/video/${key}`)
    );

    const unusedKeys = [];
    try {
        const batchResults = await db.batch(queries);
        for (let i = 0; i < keys.length; i++) {
            const hasUsed = batchResults[i]?.results?.[0]?.used;
            if (!hasUsed) {
                unusedKeys.push(keys[i]);
            }
        }
    } catch (e) {
        console.error('Batch media check failed:', e);
        return [];
    }

    return unusedKeys;
}

export const extractMediaKeys = (html) => {
    const text = String(html || '');
    const keys = new Set();
    for (const tag of text.matchAll(MEDIA_TAG_RE)) {
        const match = tag[0].match(LOCAL_MEDIA_SRC_RE);
        if (match && match[2]) {
            const key = match[2].split(/[?#]/)[0];
            if (key) keys.add(key);
        }
    }
    return [...keys];
};

export async function cleanupImages(bucket, oldHtml, newHtml, db = null) {
    if (!bucket || !oldHtml) return;

    try {
        const oldKeys = extractMediaKeys(oldHtml).filter((key) => !isProtectedKey(key));
        if (!oldKeys.length) return;

        const keep = new Set(newHtml ? extractMediaKeys(newHtml) : []);
        const deleteCandidates = oldKeys.filter((key) => !keep.has(key));
        const toDelete = await filterUnusedMediaKeys(db, deleteCandidates);

        if (toDelete.length) {
            await Promise.allSettled(toDelete.map((key) => bucket.delete(key)));
        }
    } catch (error) {
        console.error('Media cleanup failed:', error);
    }
}

export function toBackupEntry(row) {
    return {
        id: row.id,
        title: row.title,
        category: row.category,
        subcategory: row.subcategory,
        tags: parseStoredTags(row.tags),
        content: row.content,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

export function toBackupFolder(row) {
    return {
        category: row.category,
        subcategory: row.subcategory,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}
