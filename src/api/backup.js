import { Hono } from 'hono';
import { Readable } from 'stream';
import { authMiddleware } from '../lib/auth.js';
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
  serializeTags,
  toBackupEntry,
  toBackupFolder
} from '../lib/utils.js';
import { UPSERT_FOLDER_SQL, UPSERT_NOTE_SQL } from '../lib/sql.js';
import { db } from '../lib/core.js';

const router = new Hono();
const MAX_RESTORE_FILE = 100 * 1024 * 1024;
const MAX_RESTORE_REQUEST = 4 * 1024 * 1024;
const RESTORE_CHUNK_SIZE = 100;
const SANITIZE_BATCH_SIZE = 10;
const jsonEncoder = new TextEncoder();
const STREAM_RESTORE_HEADER = 'x-backup-upload';
const STREAM_RESTORE_MODE = 'file';
const SEARCH_BUFFER_TAIL = 128;
const ROOT_ARRAY_RE = /^\s*\[/;
const ROOT_OBJECT_RE = /^\s*\{/;
const ARRAY_MARKERS = [
  { kind: 'folders', regex: /"folders"\s*:\s*\[/ },
  { kind: 'notes', regex: /"(?:notes|diaries|entries|list)"\s*:\s*\[/ }
];

function extractRestoreEntries(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    for (const key of ['notes', 'diaries', 'entries', 'list']) {
      if (Array.isArray(payload[key])) return payload[key];
    }
  }
  return null;
}

function extractRestoreFolders(payload) {
  return payload && typeof payload === 'object' && Array.isArray(payload.folders) ? payload.folders : [];
}

function normalizeRestoreEntry(entry) {
  if (!entry || typeof entry !== 'object' || !V.isUUID(entry.id)) return null;

  const rawContent = typeof entry.content === 'string' ? entry.content : '';
  const fallbackTimestamp = V.isDateStr(entry.date)
    ? `${entry.date}T00:00:00.000Z`
    : new Date().toISOString();

  const createdAt = normalizeTimestamp(entry.createdAt || entry.created_at || fallbackTimestamp, fallbackTimestamp);
  const updatedAt = normalizeTimestamp(entry.updatedAt || entry.updated_at || createdAt, createdAt);
  const title = normalizeTitle(entry.title) || deriveImportedTitle(rawContent);

  if (!title) return null;

  return {
    id: String(entry.id),
    title,
    category: normalizeFolderName(entry.category) || 'Imported',
    subcategory: normalizeFolderName(entry.subcategory) || 'Legacy',
    tags: serializeTags(normalizeTagList(entry.tags)),
    content: rawContent,
    createdAt,
    updatedAt
  };
}

function normalizeRestoreFolder(entry) {
  if (!entry || typeof entry !== 'object') return null;

  const category = normalizeFolderName(entry.category);
  if (!category) return null;

  const fallbackTimestamp = new Date().toISOString();
  const createdAt = normalizeTimestamp(entry.createdAt || entry.created_at || fallbackTimestamp, fallbackTimestamp);
  const updatedAt = normalizeTimestamp(entry.updatedAt || entry.updated_at || createdAt, createdAt);

  return {
    category,
    subcategory: normalizeFolderName(entry.subcategory),
    createdAt,
    updatedAt
  };
}

function mergeFolderTimestampRecord(target, category, subcategory, createdAt, updatedAt) {
  const key = `${category}\u0000${subcategory}`;
  const existing = target.get(key);

  if (!existing) {
    target.set(key, { category, subcategory, createdAt, updatedAt });
  } else {
    existing.createdAt = existing.createdAt < createdAt ? existing.createdAt : createdAt;
    existing.updatedAt = existing.updatedAt > updatedAt ? existing.updatedAt : updatedAt;
  }
}

function trackDerivedFolders(target, entry) {
  mergeFolderTimestampRecord(target, entry.category, '', entry.createdAt, entry.updatedAt);
  mergeFolderTimestampRecord(target, entry.category, entry.subcategory, entry.createdAt, entry.updatedAt);
}

function deriveFoldersFromNotes(entries) {
  const deduped = new Map();
  for (const entry of entries) trackDerivedFolders(deduped, entry);
  return [...deduped.values()];
}

function collectNormalizedRestoreEntries(entries) {
  const validEntries = entries.map(normalizeRestoreEntry).filter(Boolean);
  return { skipped: entries.length - validEntries.length, validEntries };
}

async function sanitizeEntriesInPlace(entries) {
  for (let i = 0; i < entries.length; i += SANITIZE_BATCH_SIZE) {
    const batch = entries.slice(i, i + SANITIZE_BATCH_SIZE);
    const sanitized = await Promise.all(batch.map((entry) => sanitizeContent(entry.content)));
    batch.forEach((entry, index) => { entry.content = sanitized[index]; });
  }
}

function restoreEntriesInTransaction(entries) {
  if (!entries.length) return;
  const stmt = db.prepare(UPSERT_NOTE_SQL);
  for (const entry of entries) {
    stmt.bind(entry.id, entry.title, entry.category, entry.subcategory, entry.tags, entry.content, entry.createdAt, entry.updatedAt).runSync();
  }
}

function restoreFoldersInTransaction(folders) {
  if (!Array.isArray(folders) || folders.length === 0) return;
  const stmt = db.prepare(UPSERT_FOLDER_SQL);
  for (const folder of folders) {
    if (!folder?.category) continue;
    stmt.bind(folder.category, '', folder.createdAt, folder.updatedAt).runSync();
    if (folder.subcategory) {
      stmt.bind(folder.category, folder.subcategory, folder.createdAt, folder.updatedAt).runSync();
    }
  }
}

function beginRestoreTransaction(state) {
  if (state.open) return;
  db.exec('BEGIN IMMEDIATE');
  state.open = true;
}

function commitRestoreTransaction(state) {
  if (!state.open) return;
  db.exec('COMMIT');
  state.open = false;
}

function rollbackRestoreTransaction(state) {
  if (!state.open) return;
  try { db.exec('ROLLBACK'); } finally { state.open = false; }
}

function createStreamingBackupParser({ onFolder, onNote }) {
  let mode = 'detectRoot', rootType = '', currentArrayKind = '', searchBuffer = '';
  let itemBuffer = '', itemDepth = 0, itemStarted = false, inString = false, escapeNext = false;
  let sawRelevantArray = false, sawNoteArray = false;

  const resetItemState = () => {
    itemBuffer = ''; itemDepth = 0; itemStarted = false; inString = false; escapeNext = false;
  };

  const activateArray = (kind) => {
    currentArrayKind = kind;
    mode = 'array';
    sawRelevantArray = true;
    if (kind === 'notes') sawNoteArray = true;
  };

  const emitCurrentItem = async () => {
    const raw = itemBuffer.trim();
    resetItemState();
    if (!raw) return;

    const parsed = JSON.parse(raw);
    if (currentArrayKind === 'folders') await onFolder(parsed);
    else if (currentArrayKind === 'notes') await onNote(parsed);
    else throw new Error('Invalid backup format');
  };

  const closeCurrentArray = () => {
    resetItemState();
    currentArrayKind = '';
    mode = rootType === 'array' ? 'done' : 'seekArrays';
  };

  const processArrayChar = async (char) => {
    if (!itemStarted) {
      if (/\s/.test(char) || char === ',') return;
      if (char === ']') return closeCurrentArray();

      itemStarted = true;
      itemBuffer = char;
      itemDepth = char === '{' || char === '[' ? 1 : 0;
      inString = char === '"';
      escapeNext = false;

      if (itemDepth === 0 && !inString) await emitCurrentItem();
      return;
    }

    itemBuffer += char;

    if (inString) {
      if (escapeNext) escapeNext = false;
      else if (char === '\\') escapeNext = true;
      else if (char === '"') inString = false;
      return;
    }

    if (char === '"') inString = true;
    else if (char === '{' || char === '[') itemDepth += 1;
    else if (char === '}' || char === ']') {
      itemDepth -= 1;
      if (itemDepth === 0) await emitCurrentItem();
    }
  };

  const keepSearchTail = () => { searchBuffer = searchBuffer.slice(-SEARCH_BUFFER_TAIL); };

  const detectRoot = () => {
    searchBuffer = searchBuffer.replace(/^\uFEFF/, '');
    const arrayMatch = searchBuffer.match(ROOT_ARRAY_RE);
    if (arrayMatch) {
      rootType = 'array';
      const remainder = searchBuffer.slice((arrayMatch.index ?? 0) + arrayMatch[0].length);
      searchBuffer = '';
      activateArray('notes');
      return remainder;
    }

    const objectMatch = searchBuffer.match(ROOT_OBJECT_RE);
    if (objectMatch) {
      rootType = 'object';
      const remainder = searchBuffer.slice((objectMatch.index ?? 0) + objectMatch[0].length);
      searchBuffer = '';
      mode = 'seekArrays';
      return remainder;
    }

    if (/\S/.test(searchBuffer)) throw new Error('Invalid backup format');
    keepSearchTail();
    return null;
  };

  const searchForNextArray = () => {
    let found = null;
    for (const marker of ARRAY_MARKERS) {
      const match = searchBuffer.match(marker.regex);
      if (match && (!found || (match.index ?? 0) < found.index)) {
        found = { kind: marker.kind, index: match.index ?? 0, length: match[0].length };
      }
    }

    if (!found) { keepSearchTail(); return null; }
    const remainder = searchBuffer.slice(found.index + found.length);
    searchBuffer = '';
    activateArray(found.kind);
    return remainder;
  };

  return {
    async push(text) {
      let remaining = text;
      while (remaining) {
        if (mode === 'done') return;

        if (mode === 'detectRoot') {
          searchBuffer += remaining;
          const next = detectRoot();
          if (next == null) return;
          remaining = next;
          continue;
        }

        if (mode === 'seekArrays') {
          searchBuffer += remaining;
          const next = searchForNextArray();
          if (next == null) return;
          remaining = next;
          continue;
        }

        for (let i = 0; i < remaining.length; i += 1) {
          await processArrayChar(remaining[i]);
          if (mode !== 'array') {
            remaining = remaining.slice(i + 1);
            break;
          }
          if (i === remaining.length - 1) remaining = '';
        }
      }
    },
    async finish() {
      if (!rootType || mode === 'detectRoot' || mode === 'array' || itemStarted || inString || itemDepth !== 0) {
        throw new Error('Invalid backup format');
      }
      if (!sawRelevantArray || !sawNoteArray) throw new Error('Invalid data format');
    }
  };
}

function getDeclaredBackupSize(c, fallback) {
  const headerBytes = Number(c.req.header('X-Backup-Size'));
  return Number.isFinite(headerBytes) && headerBytes > 0 ? headerBytes : fallback;
}

async function restoreFromUploadedFile(c) {
  const declaredBytes = getDeclaredBackupSize(c, getContentLength(c));
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_RESTORE_FILE) {
    return jsonError(c, 'Backup file too large (max 100MB)', 413);
  }
  if (!c.req.raw.body) return jsonError(c, 'No data provided.', 400);

  let count = 0, skipped = 0, explicitFolderCount = 0, receivedBytes = 0;
  const explicitFolders = [];
  const derivedFolders = new Map();
  const transactionState = { open: false };
  let noteBatch = [];

  const flushNotes = async () => {
    if (!noteBatch.length) return;
    const batch = noteBatch;
    noteBatch = [];
    await sanitizeEntriesInPlace(batch);
    beginRestoreTransaction(transactionState);
    restoreEntriesInTransaction(batch);
  };

  try {
    const parser = createStreamingBackupParser({
      onFolder: async (folderEntry) => {
        const normalized = normalizeRestoreFolder(folderEntry);
        if (normalized) {
          explicitFolders.push(normalized);
          explicitFolderCount += 1;
        }
      },
      onNote: async (noteEntry) => {
        const normalized = normalizeRestoreEntry(noteEntry);
        if (!normalized) { skipped += 1; return; }

        count += 1;
        trackDerivedFolders(derivedFolders, normalized);
        noteBatch.push(normalized);
        if (noteBatch.length >= RESTORE_CHUNK_SIZE) await flushNotes();
      }
    });

    const decoder = new TextDecoder();
    for await (const chunk of Readable.fromWeb(c.req.raw.body)) {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_RESTORE_FILE) {
        throw Object.assign(new Error('Backup file too large (max 100MB)'), { status: 413 });
      }
      await parser.push(decoder.decode(chunk, { stream: true }));
    }

    await parser.push(decoder.decode());
    await parser.finish();
    await flushNotes();

    beginRestoreTransaction(transactionState);
    restoreFoldersInTransaction([...explicitFolders, ...derivedFolders.values()]);
    commitRestoreTransaction(transactionState);

    return c.json({ success: true, count, skipped, folderCount: explicitFolderCount });
  } catch (error) {
    rollbackRestoreTransaction(transactionState);
    const message = error?.message || 'Restore failed';
    const status = error?.status || (message.includes('too large') ? 413 : /^Invalid|^No data/i.test(message) ? 400 : 500);
    return jsonError(c, message, status);
  }
}

function buildExportScope(category, subcategory) {
  const conditions = [];
  if (category) conditions.push(['category', category]);
  if (category && subcategory) conditions.push(['subcategory', subcategory]);

  const params = conditions.map(([, v]) => v);
  const noteWhere = conditions.length ? ` WHERE ${conditions.map(([col]) => `n.${col} = ?`).join(' AND ')}` : '';
  const folderWhere = conditions.length ? ` WHERE ${conditions.map(([col]) => `${col} = ?`).join(' AND ')}` : '';

  return { noteWhere, noteParams: params, folderWhere, folderParams: [...params] };
}

async function countRows(sql, params) {
  return Number((await db.prepare(sql).bind(...params).first())?.total ?? 0);
}

async function* streamBackupJson({ exportedAt, scopeLabel, noteWhere, noteParams, folderWhere, folderParams, noteCount, folderCount }) {
  const encode = (str) => jsonEncoder.encode(str);

  yield encode(`{"exportedAt":${JSON.stringify(exportedAt)},"scope":${JSON.stringify(scopeLabel)},"count":${noteCount},"folderCount":${folderCount},"folders":[`);

  let first = true;
  for (const row of db.prepare(`SELECT * FROM folders${folderWhere} ORDER BY lower(category) ASC, lower(subcategory) ASC`).bind(...folderParams).iterate()) {
    yield encode(`${first ? '' : ','}${JSON.stringify(toBackupFolder(row))}`);
    first = false;
  }

  yield encode('],"notes":[');

  first = true;
  for (const row of db.prepare(`SELECT * FROM notes n${noteWhere} ORDER BY updated_at DESC`).bind(...noteParams).iterate()) {
    yield encode(`${first ? '' : ','}${JSON.stringify(toBackupEntry(row))}`);
    first = false;
  }

  yield encode(']}');
}

router.get('/export', authMiddleware, async (c) => {
  try {
    const category = String(c.req.query('category') || '').trim();
    const subcategory = String(c.req.query('subcategory') || '').trim();
    const { noteWhere, noteParams, folderWhere, folderParams } = buildExportScope(category, subcategory);

    const scopeLabel = subcategory ? `${category}-${subcategory}` : category || 'all';
    const exportedAt = new Date().toISOString();
    const [noteCount, folderCount] = await Promise.all([
      countRows(`SELECT COUNT(*) AS total FROM notes n${noteWhere}`, noteParams),
      countRows(`SELECT COUNT(*) AS total FROM folders${folderWhere}`, folderParams)
    ]);

    const data = Readable.toWeb(Readable.from(streamBackupJson({
      exportedAt, scopeLabel, noteWhere, noteParams, folderWhere, folderParams, noteCount, folderCount
    })));

    const safeScope = scopeLabel.replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const filename = `note-backup-${safeScope || 'all'}-${new Date().toISOString().split('T')[0]}.json`;
    const utfFilename = `note-backup-${scopeLabel || 'all'}-${new Date().toISOString().split('T')[0]}.json`;

    return new Response(data, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(utfFilename)}`
      }
    });
  } catch (e) {
    return jsonError(c, `Export Failed: ${escapeHtml(e.message)}`, 500);
  }
});

router.post('/restore', authMiddleware, async (c) => {
  if (String(c.req.header(STREAM_RESTORE_HEADER) || '').toLowerCase() === STREAM_RESTORE_MODE) {
    return restoreFromUploadedFile(c);
  }

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
    if (!entries) return jsonError(c, 'Invalid data format', 400);

    const restoreFolders = extractRestoreFolders(parsed).map(normalizeRestoreFolder).filter(Boolean);
    const { skipped, validEntries } = collectNormalizedRestoreEntries(entries);
    const derivedFolders = deriveFoldersFromNotes(validEntries);
    const count = validEntries.length;

    await sanitizeEntriesInPlace(validEntries);

    const transactionState = { open: false };
    try {
      beginRestoreTransaction(transactionState);
      restoreFoldersInTransaction([...restoreFolders, ...derivedFolders]);
      restoreEntriesInTransaction(validEntries);
      commitRestoreTransaction(transactionState);
    } catch (error) {
      rollbackRestoreTransaction(transactionState);
      throw error;
    }

    return c.json({ success: true, count, skipped, folderCount: restoreFolders.length });
  } catch (e) {
    return jsonError(c, e?.message || 'Unknown error', 500);
  }
});

export default router;