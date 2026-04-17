import { Hono } from 'hono';
import { authMiddleware } from '../lib/auth.js';
import { restoreFolderEntries } from '../lib/folders.js';
import { jsonError, getContentLength, parseJsonBody } from '../lib/http.js';
import { sanitizeContent } from '../lib/sanitize.js';
import { V } from '../lib/validate.js';
import {
  deriveImportedTitle,
  escapeHtml,
  normalizeFolderName,
  normalizeTagList,
  normalizeTimestamp,
  normalizeTitle,
  parseStoredTags,
  serializeTags,
  toBackupEntry,
  toBackupFolder
} from '../lib/utils.js';
import { UPSERT_NOTE_SQL } from '../lib/sql.js';
import { db } from '../lib/core.js';

const router = new Hono();
const MAX_RESTORE_FILE = 100 * 1024 * 1024;
const MAX_RESTORE_REQUEST = 4 * 1024 * 1024;
const RESTORE_CHUNK_SIZE = 100;
const SANITIZE_BATCH_SIZE = 10;

async function restoreInChunks(db, entries) {
  if (!entries.length) return;
  const stmt = db.prepare(UPSERT_NOTE_SQL);
  for (let i = 0; i < entries.length; i += RESTORE_CHUNK_SIZE) {
    const chunk = entries.slice(i, i + RESTORE_CHUNK_SIZE);
    await db.batch(chunk.map((e) => stmt.bind(
      e.id,
      e.title,
      e.category,
      e.subcategory,
      e.tags,
      e.content,
      e.createdAt,
      e.updatedAt
    )));
  }
}

function extractRestoreEntries(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.notes)) return payload.notes;
    if (Array.isArray(payload.diaries)) return payload.diaries;
    if (Array.isArray(payload.entries)) return payload.entries;
    if (Array.isArray(payload.list)) return payload.list;
  }
  return null;
}

function extractRestoreFolders(payload) {
  if (payload && typeof payload === 'object' && Array.isArray(payload.folders)) {
    return payload.folders;
  }
  return [];
}

function normalizeRestoreEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (!V.isUUID(entry.id)) return null;

  const rawContent = typeof entry.content === 'string' ? entry.content : '';
  const fallbackTimestamp = V.isDateStr(entry.date)
    ? `${entry.date}T00:00:00.000Z`
    : new Date().toISOString();

  const createdAt = normalizeTimestamp(entry.createdAt || entry.created_at || fallbackTimestamp, fallbackTimestamp);
  const updatedAt = normalizeTimestamp(entry.updatedAt || entry.updated_at || createdAt, createdAt);
  const title = normalizeTitle(entry.title) || deriveImportedTitle(rawContent);
  const category = normalizeFolderName(entry.category) || 'Imported';
  const subcategory = normalizeFolderName(entry.subcategory) || 'Legacy';
  const tags = serializeTags(normalizeTagList(entry.tags));

  if (!title) return null;

  return {
    id: String(entry.id),
    title,
    category,
    subcategory,
    tags,
    content: rawContent,
    createdAt,
    updatedAt
  };
}

function normalizeRestoreFolder(entry) {
  if (!entry || typeof entry !== 'object') return null;

  const category = normalizeFolderName(entry.category);
  const subcategory = normalizeFolderName(entry.subcategory);
  if (!category) return null;

  const fallbackTimestamp = new Date().toISOString();
  const createdAt = normalizeTimestamp(entry.createdAt || entry.created_at || fallbackTimestamp, fallbackTimestamp);
  const updatedAt = normalizeTimestamp(entry.updatedAt || entry.updated_at || createdAt, createdAt);

  return {
    category,
    subcategory,
    createdAt,
    updatedAt
  };
}

function deriveFoldersFromNotes(entries) {
  const deduped = new Map();

  for (const entry of entries) {
    const rootKey = `${entry.category}\u0000`;
    const subKey = `${entry.category}\u0000${entry.subcategory}`;

    if (!deduped.has(rootKey)) {
      deduped.set(rootKey, {
        category: entry.category,
        subcategory: '',
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt
      });
    } else {
      const existingRoot = deduped.get(rootKey);
      existingRoot.createdAt = existingRoot.createdAt < entry.createdAt ? existingRoot.createdAt : entry.createdAt;
      existingRoot.updatedAt = existingRoot.updatedAt > entry.updatedAt ? existingRoot.updatedAt : entry.updatedAt;
    }

    if (!deduped.has(subKey)) {
      deduped.set(subKey, {
        category: entry.category,
        subcategory: entry.subcategory,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt
      });
    } else {
      const existingSub = deduped.get(subKey);
      existingSub.createdAt = existingSub.createdAt < entry.createdAt ? existingSub.createdAt : entry.createdAt;
      existingSub.updatedAt = existingSub.updatedAt > entry.updatedAt ? existingSub.updatedAt : entry.updatedAt;
    }
  }

  return [...deduped.values()];
}

async function sanitizeRestoreEntries(entries) {
  let skipped = 0;
  const validEntries = [];

  for (const entry of entries) {
    const normalized = normalizeRestoreEntry(entry);
    if (!normalized) {
      skipped += 1;
      continue;
    }
    validEntries.push(normalized);
  }

  for (let i = 0; i < validEntries.length; i += SANITIZE_BATCH_SIZE) {
    const batch = validEntries.slice(i, i + SANITIZE_BATCH_SIZE);
    const sanitized = await Promise.all(batch.map((entry) => sanitizeContent(entry.content)));
    batch.forEach((entry, index) => {
      entry.content = sanitized[index];
    });
  }

  return { skipped, validEntries };
}

router.get('/export', authMiddleware, async (c) => {
  try {
    const category = String(c.req.query('category') || '').trim();
    const subcategory = String(c.req.query('subcategory') || '').trim();

    const conditions = [];
    const params = [];
    if (category) {
      conditions.push('n.category = ?');
      params.push(category);
    }
    if (category && subcategory) {
      conditions.push('n.subcategory = ?');
      params.push(subcategory);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';

    const folderConditions = [];
    const folderParams = [];
    if (category) {
      folderConditions.push('category = ?');
      folderParams.push(category);
    }
    if (category && subcategory) {
      folderConditions.push('subcategory = ?');
      folderParams.push(subcategory);
    }
    const folderWhere = folderConditions.length ? ` WHERE ${folderConditions.join(' AND ')}` : '';

    const [notesRes, foldersRes] = await db.batch([
      db.prepare(`SELECT * FROM notes n${where} ORDER BY updated_at DESC`).bind(...params),
      db.prepare(`SELECT * FROM folders${folderWhere} ORDER BY lower(category) ASC, lower(subcategory) ASC`).bind(...folderParams)
    ]);
    const notes = (notesRes.results || []).map(toBackupEntry);
    const folders = (foldersRes.results || []).map(toBackupFolder);

    const scopeLabel = subcategory ? `${category}-${subcategory}` : category || 'all';
    const data = JSON.stringify({
      exportedAt: new Date().toISOString(),
      scope: scopeLabel,
      count: notes.length,
      folderCount: folders.length,
      folders,
      notes
    });
    const filename = `note-backup-${scopeLabel}-${new Date().toISOString().split('T')[0]}.json`;
    return new Response(data, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${filename}"`
      }
    });
  } catch (e) {
    return jsonError(c, `Export Failed: ${escapeHtml(e.message)}`, 500);
  }
});

router.post('/restore', authMiddleware, async (c) => {
  const contentLength = getContentLength(c);
  if (contentLength != null && contentLength > MAX_RESTORE_REQUEST) {
    return jsonError(c, 'Restore payload too large. Please retry from the app.', 413);
  }

  try {
    const { value: parsed, response } = await parseJsonBody(c, 'Invalid JSON');
    if (response) return response;

    const totalBytes = Number(parsed?.totalBytes);
    if (Number.isFinite(totalBytes) && totalBytes > MAX_RESTORE_FILE) {
      return jsonError(c, 'Backup file too large (max 100MB)', 413);
    }

    const entries = extractRestoreEntries(parsed);
    if (!entries) {
      return jsonError(c, 'Invalid data format', 400);
    }

    const restoreFolders = extractRestoreFolders(parsed)
      .map(normalizeRestoreFolder)
      .filter(Boolean);
    const { skipped, validEntries } = await sanitizeRestoreEntries(entries);
    const derivedFolders = deriveFoldersFromNotes(validEntries);
    const count = validEntries.length;

    await restoreFolderEntries(db, [...restoreFolders, ...derivedFolders]);
    await restoreInChunks(db, validEntries);

    return c.json({
      success: true,
      count,
      skipped,
      folderCount: restoreFolders.length
    });
  } catch (e) {
    return jsonError(c, e?.message || 'Unknown error', 500);
  }
});

export default router;
