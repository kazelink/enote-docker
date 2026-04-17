import { Hono } from 'hono';
import { authMiddleware } from '../lib/auth.js';
import { cleanupImages, normalizeFolderName } from '../lib/utils.js';
import { ensureFolderRecords, loadFolderTree } from '../lib/folders.js';
import { jsonError, parseJsonBody } from '../lib/http.js';
import { db, bucket, runBackground } from '../lib/core.js';

const router = new Hono();

router.get('/tree', authMiddleware, async (c) => {
  try {
    const tree = await loadFolderTree(db);
    return c.json(tree);
  } catch (err) {
    console.error('Failed to load folder tree:', err);
    return jsonError(c, 'Failed to load folder tree', 500);
  }
});

router.post('/', authMiddleware, async (c) => {
  const { value: body, response } = await parseJsonBody(c);
  if (response) return response;

  const category = normalizeFolderName(body?.category);
  const subcategory = normalizeFolderName(body?.subcategory);

  if (!category) {
    return jsonError(c, 'Major category required', 400);
  }

  const now = new Date().toISOString();
  await ensureFolderRecords(db, category, subcategory, now, now);

  return c.json({
    success: true,
    category,
    subcategory,
    createdAt: now,
    updatedAt: now
  });
});

router.delete('/', authMiddleware, async (c) => {
  const category = normalizeFolderName(c.req.query('category'));
  const subcategory = normalizeFolderName(c.req.query('subcategory'));

  if (!category) {
    return jsonError(c, 'Major category required', 400);
  }

  const folderWhere = subcategory
    ? { sql: 'category = ? AND subcategory = ?', params: [category, subcategory] }
    : { sql: 'category = ?', params: [category] };
  const noteWhere = subcategory
    ? { sql: 'category = ? AND subcategory = ?', params: [category, subcategory] }
    : { sql: 'category = ?', params: [category] };

  const { results } = await db.prepare(
    `SELECT content FROM notes WHERE ${noteWhere.sql}`
  ).bind(...noteWhere.params).all();

  const deleteNotesStmt = db.prepare(
    `DELETE FROM notes WHERE ${noteWhere.sql}`
  ).bind(...noteWhere.params);
  const deleteFoldersStmt = db.prepare(
    `DELETE FROM folders WHERE ${folderWhere.sql}`
  ).bind(...folderWhere.params);

  await db.batch([deleteNotesStmt, deleteFoldersStmt]);

  const contents = (results || [])
    .map((row) => (typeof row?.content === 'string' ? row.content : ''))
    .filter(Boolean);
  if (contents.length > 0) {
    runBackground(cleanupImages(bucket, contents.join('\n'), '', db));
  }

  return c.json({
    success: true,
    category,
    subcategory,
    deletedNotes: contents.length
  });
});

router.put('/', authMiddleware, async (c) => {
  const { value: body, response } = await parseJsonBody(c);
  if (response) return response;

  const oldCategory = normalizeFolderName(body?.oldCategory);
  const oldSubcategory = normalizeFolderName(body?.oldSubcategory);
  const newName = normalizeFolderName(body?.newName);

  if (!oldCategory || !newName) {
    return jsonError(c, 'Invalid rename parameters', 400);
  }

  const now = new Date().toISOString();

  if (!oldSubcategory) {
    // Renaming a top-level category
    const updateNotes = db.prepare(
      'UPDATE notes SET category = ?, updated_at = ? WHERE category = ?'
    ).bind(newName, now, oldCategory);
    const updateFolders = db.prepare(
      'UPDATE folders SET category = ?, updated_at = ? WHERE category = ?'
    ).bind(newName, now, oldCategory);
    
    await db.batch([updateNotes, updateFolders]);
    
    return c.json({ success: true, oldCategory, newCategory: newName });
  } else {
    // Renaming a subcategory
    const updateNotes = db.prepare(
      'UPDATE notes SET subcategory = ?, updated_at = ? WHERE category = ? AND subcategory = ?'
    ).bind(newName, now, oldCategory, oldSubcategory);
    const updateFolders = db.prepare(
      'UPDATE folders SET subcategory = ?, updated_at = ? WHERE category = ? AND subcategory = ?'
    ).bind(newName, now, oldCategory, oldSubcategory);

    await db.batch([updateNotes, updateFolders]);
    
    return c.json({ success: true, oldCategory, oldSubcategory, newSubcategory: newName });
  }
});

export default router;
