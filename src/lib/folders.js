import { UPSERT_FOLDER_SQL } from './sql.js';
import { normalizeFolderName, normalizeTimestamp } from './utils.js';

function normalizeFolderTimestamps(createdAt, updatedAt) {
  const now = new Date().toISOString();
  const safeCreatedAt = normalizeTimestamp(createdAt, now) || now;
  const safeUpdatedAt = normalizeTimestamp(updatedAt, safeCreatedAt) || safeCreatedAt;
  return { createdAt: safeCreatedAt, updatedAt: safeUpdatedAt };
}

function buildUpsertFolderStmt(db, category, subcategory, createdAt, updatedAt) {
  if (!category) return null;
  const timestamps = normalizeFolderTimestamps(createdAt, updatedAt);
  return db.prepare(UPSERT_FOLDER_SQL)
    .bind(category, subcategory, timestamps.createdAt, timestamps.updatedAt);
}

export async function ensureFolderRecords(db, category, subcategory, createdAt, updatedAt) {
  const safeCategory = normalizeFolderName(category);
  const safeSubcategory = normalizeFolderName(subcategory);
  if (!safeCategory) return;

  const stmts = [];
  const stmt1 = buildUpsertFolderStmt(db, safeCategory, '', createdAt, updatedAt);
  if (stmt1) stmts.push(stmt1);
  if (safeSubcategory) {
    const stmt2 = buildUpsertFolderStmt(db, safeCategory, safeSubcategory, createdAt, updatedAt);
    if (stmt2) stmts.push(stmt2);
  }

  if (stmts.length) {
    await db.batch(stmts);
  }
}

export async function restoreFolderEntries(db, folders) {
  if (!Array.isArray(folders) || folders.length === 0) return;
  const stmts = [];
  for (const folder of folders) {
    const safeCategory = normalizeFolderName(folder.category);
    const safeSubcategory = normalizeFolderName(folder.subcategory);
    if (!safeCategory) continue;

    const stmt1 = buildUpsertFolderStmt(db, safeCategory, '', folder.createdAt, folder.updatedAt);
    if (stmt1) stmts.push(stmt1);
    if (safeSubcategory) {
      const stmt2 = buildUpsertFolderStmt(db, safeCategory, safeSubcategory, folder.createdAt, folder.updatedAt);
      if (stmt2) stmts.push(stmt2);
    }
  }

  // Execute in batches
  const CHUNK_SIZE = 50;
  for (let i = 0; i < stmts.length; i += CHUNK_SIZE) {
    await db.batch(stmts.slice(i, i + CHUNK_SIZE));
  }
}

export async function loadFolderTree(db) {
  const [categoriesRes, subfoldersRes] = await db.batch([
    db.prepare(`
      SELECT
        f.category,
        COALESCE(ns.cnt, 0) AS count,
        COALESCE(ns.max_upd, sf.max_upd, f.updated_at) AS updated_at
      FROM folders f
      LEFT JOIN (
        SELECT category, COUNT(*) AS cnt, MAX(updated_at) AS max_upd
        FROM notes
        GROUP BY category
      ) ns ON ns.category = f.category
      LEFT JOIN (
        SELECT category, MAX(updated_at) AS max_upd
        FROM folders
        WHERE subcategory != ''
        GROUP BY category
      ) sf ON sf.category = f.category
      WHERE f.subcategory = ''
      ORDER BY lower(f.category) ASC
    `),
    db.prepare(`
      SELECT
        f.category,
        f.subcategory,
        COALESCE(ns.cnt, 0) AS count,
        COALESCE(ns.max_upd, f.updated_at) AS updated_at
      FROM folders f
      LEFT JOIN (
        SELECT category, subcategory, COUNT(*) AS cnt, MAX(updated_at) AS max_upd
        FROM notes
        GROUP BY category, subcategory
      ) ns ON ns.category = f.category AND ns.subcategory = f.subcategory
      WHERE f.subcategory != ''
      ORDER BY lower(f.subcategory) ASC
    `)
  ]);

  const categories = categoriesRes.results || [];
  const allSubfolders = subfoldersRes.results || [];

  const subMap = new Map();
  for (const sub of allSubfolders) {
    if (!subMap.has(sub.category)) subMap.set(sub.category, []);
    subMap.get(sub.category).push(sub);
  }

  return categories.map(cat => ({
    ...cat,
    subfolders: subMap.get(cat.category) || []
  }));
}
