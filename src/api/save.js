import { Hono } from 'hono';
import { authMiddleware } from '../lib/auth.js';
import { ensureFolderRecords } from '../lib/folders.js';
import { jsonError, parseJsonBody } from '../lib/http.js';
import { sanitizeContent } from '../lib/sanitize.js';
import { cleanupImages, cleanupMediaKeys, normalizeFolderName, normalizeTagList, normalizeTitle, serializeTags } from '../lib/utils.js';
import { V } from '../lib/validate.js';
import { UPSERT_NOTE_SQL } from '../lib/sql.js';
import { db, bucket, runBackground } from '../lib/core.js';

const router = new Hono();

const MAX_SAVE_CONTENT_LENGTH = 500_000;
const TMP_MEDIA_REGEX = /\/(img|video)\/tmp\/([a-zA-Z0-9.\-_]+)/g;

function planTempMediaPromotion(content) {
  const tmpMatches = [...content.matchAll(TMP_MEDIA_REGEX)];
  const finalKeys = [...new Set(tmpMatches.map((m) => m[2]))];

  if (finalKeys.length === 0) {
    return { content, finalKeys: [] };
  }

  const updatedContent = content.replace(TMP_MEDIA_REGEX, (full, route, key) =>
    finalKeys.includes(key) ? `/${route}/${key}` : full
  );

  return { content: updatedContent, finalKeys };
}

async function promotePlannedTempMedia(bucket, finalKeys) {
  if (finalKeys.length === 0) {
    return { promotedTmpKeys: [], promotedFinalKeys: [] };
  }

  if (!bucket) throw new Error('Storage not configured');

  const results = [];
  for (const key of finalKeys) {
    const tmpKey = `tmp/${key}`;
    const obj = await bucket.get(tmpKey);
    if (!obj) throw new Error(`Missing temporary media: ${key}`);
    await bucket.put(key, obj.body, { httpMetadata: obj.httpMetadata });
    results.push({ tmpKey, finalKey: key });
  }

  return {
    promotedTmpKeys: results.map((item) => item.tmpKey),
    promotedFinalKeys: results.map((item) => item.finalKey)
  };
}

async function restorePreviousNoteState(previousNote, id) {
  if (!previousNote) {
    await db.prepare('DELETE FROM notes WHERE id = ?').bind(id).run();
    return;
  }

  await db.prepare(UPSERT_NOTE_SQL)
    .bind(
      previousNote.id,
      previousNote.title,
      previousNote.category,
      previousNote.subcategory,
      previousNote.tags,
      previousNote.content,
      previousNote.created_at,
      previousNote.updated_at
    )
    .run();
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

    const sanitizedInput = await sanitizeContent(rawContent);
    const promotionPlan = planTempMediaPromotion(sanitizedInput);
    const sanitizedContent = promotionPlan.content;
    const previousNote = body?.id
      ? await db.prepare('SELECT * FROM notes WHERE id = ?').bind(id).first()
      : null;
    const previousContent = typeof previousNote?.content === 'string' ? previousNote.content : '';

    const now = new Date().toISOString();
    const createdAt = typeof previousNote?.created_at === 'string' && previousNote.created_at
      ? previousNote.created_at
      : now;
    const updatedAt = `${date}T00:00:00.000Z`;

    await ensureFolderRecords(db, category, subcategory, createdAt, updatedAt);

    await db.prepare(UPSERT_NOTE_SQL)
      .bind(id, title, category, subcategory, serializeTags(tags), sanitizedContent, createdAt, updatedAt)
      .run();

    let promotedTmpKeys = [];
    try {
      const promotionResult = await promotePlannedTempMedia(bucket, promotionPlan.finalKeys);
      promotedTmpKeys = promotionResult.promotedTmpKeys;
    } catch (e) {
      await restorePreviousNoteState(previousNote, id);
      await cleanupMediaKeys(bucket, promotionPlan.finalKeys, db);
      return jsonError(c, e.message.includes('Missing temporary media')
        ? 'Some temporary images are missing. Please re-upload and try again.'
        : e.message, e.message.includes('Missing temporary media') ? 409 : 500);
    }

    if (promotedTmpKeys.length > 0) {
      const uniqueTmpKeys = [...new Set(promotedTmpKeys)];
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
