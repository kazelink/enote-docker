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
  if (!category) return;

  const stmts = [];
  const stmt1 = buildUpsertFolderStmt(db, category, '', createdAt, updatedAt);
  if (stmt1) stmts.push(stmt1);
  if (subcategory) {
    const stmt2 = buildUpsertFolderStmt(db, category, subcategory, createdAt, updatedAt);
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

// Optimized: Use SQLite json_group_array for tree structure in database
export async function loadFolderTree(db) {
  // Single optimized query: SQLite builds the tree structure
  const result = await db.prepare(`
    SELECT
      f.category,
      COALESCE(cat_notes.cnt, 0) AS count,
      COALESCE(cat_notes.max_upd, f.updated_at) AS updated_at,
      COALESCE(
        json_group_array(
          json_object(
            'category', sf.category,
            'subcategory', sf.subcategory,
            'count', COALESCE(sub_notes.cnt, 0),
            'updated_at', COALESCE(sub_notes.max_upd, sf.updated_at)
          )
        ) FILTER (WHERE sf.subcategory != ''),
        '[]'
      ) AS subfolders_json
    FROM folders f
    LEFT JOIN (
      SELECT category, COUNT(*) AS cnt, MAX(updated_at) AS max_upd
      FROM notes
      GROUP BY category
    ) cat_notes ON cat_notes.category = f.category
    LEFT JOIN folders sf ON sf.category = f.category
    LEFT JOIN (
      SELECT category, subcategory, COUNT(*) AS cnt, MAX(updated_at) AS max_upd
      FROM notes
      GROUP BY category, subcategory
    ) sub_notes ON sub_notes.category = sf.category AND sub_notes.subcategory = sf.subcategory
    WHERE f.subcategory = ''
    GROUP BY f.category, f.updated_at, cat_notes.cnt, cat_notes.max_upd
    ORDER BY lower(f.category) ASC
  `).all();

  if (!result?.results) return [];

  // Parse JSON and build tree
  return result.results.map(row => {
    try {
      const subfolders = row.subfolders_json ? JSON.parse(row.subfolders_json) : [];
      return {
        category: row.category,
        count: row.count,
        updated_at: row.updated_at,
        subfolders: Array.isArray(subfolders) ? subfolders : []
      };
    } catch (e) {
      console.error('Failed to parse subfolders JSON:', e);
      return {
        category: row.category,
        count: row.count,
        updated_at: row.updated_at,
        subfolders: []
      };
    }
  });
}
