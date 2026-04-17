import { Hono } from 'hono';
import { authMiddleware } from '../lib/auth.js';
import { ensureFolderRecords } from '../lib/folders.js';
import { jsonError, parseJsonBody } from '../lib/http.js';
import { sanitizeContent } from '../lib/sanitize.js';
import { cleanupImages, normalizeFolderName, normalizeTagList, normalizeTitle, serializeTags } from '../lib/utils.js';
import { V } from '../lib/validate.js';
import { UPSERT_NOTE_SQL } from '../lib/sql.js';
import { db, bucket, runBackground } from '../lib/core.js';

const router = new Hono();

const MAX_SAVE_CONTENT_LENGTH = 500_000;
const TMP_MEDIA_REGEX = /\/(img|video)\/tmp\/([a-zA-Z0-9.\-_]+)/g;
const MAX_PROMOTE_CONCURRENCY = 4;

async function runWithConcurrency(items, maxConcurrent, worker) {
  const workerCount = Math.max(1, Math.min(maxConcurrent, items.length));
  let idx = 0;
  const runners = Array.from({ length: workerCount }, async () => {
    while (idx < items.length) {
      const current = items[idx];
      idx += 1;
      await worker(current);
    }
  });
  await Promise.all(runners);
}

async function promoteTempMedia(bucket, content) {
  const tmpMatches = [...content.matchAll(TMP_MEDIA_REGEX)];
  const tmpKeys = [...new Set(tmpMatches.map((m) => m[2]))];

  if (tmpKeys.length === 0) {
    return { content, promotedKeys: [] };
  }

  if (!bucket) throw new Error('Storage not configured');

  const promoted = new Set();
  const promotedKeys = [];

  await runWithConcurrency(tmpKeys, MAX_PROMOTE_CONCURRENCY, async (key) => {
    const tmpKey = `tmp/${key}`;
    const obj = await bucket.get(tmpKey);
    if (!obj) return;
    await bucket.put(key, obj.body, { httpMetadata: obj.httpMetadata });
    promoted.add(key);
    promotedKeys.push(tmpKey);
  });

  const missing = tmpKeys.filter((key) => !promoted.has(key));
  if (missing.length > 0) {
    throw new Error('Some temporary images are missing. Please re-upload and try again.');
  }

  const updatedContent = content.replace(TMP_MEDIA_REGEX, (full, route, key) =>
    promoted.has(key) ? `/${route}/${key}` : full
  );

  return { content: updatedContent, promotedKeys };
}

function parseAndValidateRequest(body) {
  const { id: clientId, title, category, subcategory, tags, content, date } = body || {};

  if (clientId && !V.isUUID(clientId)) throw new Error('Invalid client ID format');

  const normalizedTitle = normalizeTitle(title);
  if (!normalizedTitle) throw new Error('Title required');

  const normalizedCategory = normalizeFolderName(category);
  if (!normalizedCategory) throw new Error('Major category required');

  const normalizedSubcategory = normalizeFolderName(subcategory);
  if (!normalizedSubcategory) throw new Error('Minor category required');

  const rawContent = typeof content === 'string' ? content : '';
  if (rawContent.length > MAX_SAVE_CONTENT_LENGTH) {
    const err = new Error('Content too large');
    err.status = 413;
    throw err;
  }

  const normalizedDate = typeof date === 'string' && V.isDateStr(date)
    ? date
    : new Date().toISOString().slice(0, 10);

  return {
    id: clientId || crypto.randomUUID(),
    title: normalizedTitle,
    category: normalizedCategory,
    subcategory: normalizedSubcategory,
    tags: normalizeTagList(tags),
    date: normalizedDate,
    rawContent
  };
}

router.post('/', authMiddleware, async (c) => {
  const { value: body, response } = await parseJsonBody(c);
  if (response) return response;

  try {
    const {
      id,
      title,
      category,
      subcategory,
      tags,
      date,
      rawContent
    } = parseAndValidateRequest(body);

    let sanitizedContent = await sanitizeContent(rawContent);
    const previousNote = body?.id
      ? await db.prepare('SELECT content, created_at FROM notes WHERE id = ?').bind(id).first()
      : null;
    const previousContent = typeof previousNote?.content === 'string' ? previousNote.content : '';

    let promotedKeys = [];
    try {
      const promotionResult = await promoteTempMedia(bucket, sanitizedContent);
      sanitizedContent = promotionResult.content;
      promotedKeys = promotionResult.promotedKeys;
    } catch (e) {
      return jsonError(c, e.message, e.message.includes('missing') ? 409 : 500);
    }

    const now = new Date().toISOString();
    const createdAt = typeof previousNote?.created_at === 'string' && previousNote.created_at
      ? previousNote.created_at
      : now;
    const updatedAt = `${date}T00:00:00.000Z`;

    await ensureFolderRecords(db, category, subcategory, createdAt, updatedAt);

    await db.prepare(UPSERT_NOTE_SQL)
      .bind(id, title, category, subcategory, serializeTags(tags), sanitizedContent, createdAt, updatedAt)
      .run();

    if (promotedKeys.length > 0) {
      const uniqueTmpKeys = [...new Set(promotedKeys)];
      runBackground((async () => {
        await Promise.allSettled(uniqueTmpKeys.map((key) => bucket.delete(key)));
      })());
    }

    if (previousContent) {
      runBackground(
        cleanupImages(bucket, previousContent, sanitizedContent, db).catch((e) => {
          console.error('Image cleanup failed after save:', e);
        })
      );
    }

    return c.json({
      success: true,
      id,
      title,
      category,
      subcategory,
      tags,
      content: sanitizedContent,
      createdAt,
      updatedAt
    });
  } catch (e) {
    return jsonError(c, e.message, e.status || 400);
  }
});

export default router;
