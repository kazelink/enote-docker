import { Hono } from 'hono';
import { authMiddleware } from '../lib/auth.js';
import { db } from '../lib/core.js';

const router = new Hono();

router.get('/', authMiddleware, async (c) => {
  const { results } = await db.prepare(`
    SELECT
      MIN(tag_name) AS tag,
      COUNT(DISTINCT note_id) AS count
    FROM note_tags
    GROUP BY tag_key
    ORDER BY tag_key ASC
  `).all();

  return c.json(results ?? []);
});

export default router;
