import { Hono } from 'hono';
import { authMiddleware } from '../lib/auth.js';
import { db } from '../lib/core.js';

const router = new Hono();

router.get('/', authMiddleware, async (c) => {
  const { results } = await db.prepare(`
    SELECT
      MIN(tag) AS tag,
      COUNT(DISTINCT note_id) AS count
    FROM (
      SELECT
        trim(CAST(json_each.value AS TEXT)) AS tag,
        lower(trim(CAST(json_each.value AS TEXT))) AS tag_key,
        n.id AS note_id
      FROM notes n, json_each(n.tags)
      WHERE json_valid(n.tags)
        AND trim(CAST(json_each.value AS TEXT)) != ''
    )
    GROUP BY tag_key
    ORDER BY tag_key ASC
  `).all();

  return c.json(results ?? []);
});

export default router;
