import { Hono } from 'hono';
import { authMiddleware } from '../lib/auth.js';
import {
  escapeHtml,
  parseStoredTags
} from '../lib/utils.js';
import { jsonError } from '../lib/http.js';
import { V } from '../lib/validate.js';
import { db } from '../lib/core.js';

const router = new Hono();

function toClientNote(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    subcategory: row.subcategory,
    tags: parseStoredTags(row.tags),
    content: typeof row.content === 'string' ? row.content : '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function encodeInlineParam(value) {
  return encodeURIComponent(String(value || '')).replace(/'/g, '%27');
}

function renderArchiveDeleteAction(noteId) {
  return `
      <span class="archive-actions">
        <button class="archive-delete-btn" type="button" aria-label="Delete note"
          onclick="event.stopPropagation(); App.deleteEntry('${noteId}')">
          <i class="ri-close-line"></i>
        </button>
      </span>
  `;
}

function renderArchiveRow(note) {
  const safeId = escapeHtml(note.id);
  const safeTitle = escapeHtml(note.title || 'Untitled Note');
  const encodedCategory = encodeInlineParam(note.category);
  const encodedSubcategory = encodeInlineParam(note.subcategory);
  const tagsHtml = note.tags.length
    ? note.tags.map((tag) => {
      const safeTag = escapeHtml(tag);
      const encodedTag = encodeInlineParam(tag);
      return `<button class="archive-tag" type="button" onclick="event.stopPropagation(); App.toggleTagByEncoded('${encodedTag}')">#${safeTag}</button>`;
    }).join('')
    : '';

  return `
    <div class="archive-row" role="button" tabindex="0" data-id="${safeId}"
      onclick="App.openNoteById('${safeId}', '${encodedCategory}', '${encodedSubcategory}')"
      onkeydown="if(event.key==='Enter' || event.key===' '){event.preventDefault();App.openNoteById('${safeId}', '${encodedCategory}', '${encodedSubcategory}')}">
      <div class="archive-track"><span class="archive-dot"></span></div>
      <div class="archive-title">${safeTitle}</div>
      <div class="archive-meta">
        <div class="archive-tags">${tagsHtml}</div>
      </div>
      ${renderArchiveDeleteAction(safeId)}
    </div>
  `;
}

function renderArchiveList(notes) {
  return `<div class="archive-list">${notes.map((note) => renderArchiveRow(note)).join('')}</div>`;
}

function renderPagination(currPg, totalPg) {
  const safeTotal = Math.max(1, totalPg);
  const pgStyle = safeTotal > 1 ? 'flex' : 'none';
  return `
    <div class="pg-box" data-pagination style="display:${pgStyle}">
      <span class="pg-btn" onclick="App.changePage(-1)"><i class="ri-arrow-left-s-line"></i></span>
      <div class="pg-status">
        <span class="pg-status-txt" onclick="App.toggleJump(true)">${currPg}</span>
        <input type="number" class="pg-inp" style="display:none"
          value="${currPg}"
          onblur="App.toggleJump(false)"
          onkeydown="if(event.key==='Enter')this.blur()">
        <span>/ <span class="pg-total">${safeTotal}</span></span>
      </div>
      <span class="pg-btn" onclick="App.changePage(1)"><i class="ri-arrow-right-s-line"></i></span>
      <div class="pg-data" data-total="${safeTotal}" style="display:none"></div>
    </div>
  `;
}

function buildQuery(category, subcategory, search, tag) {
  const conditions = [];
  const params = [];
  const safeTagsJson = `CASE WHEN json_valid(n.tags) THEN n.tags ELSE '[]' END`;

  const safeCategory = String(category || '').trim();
  const safeSubcategory = String(subcategory || '').trim();
  if (safeCategory) {
    conditions.push('n.category = ?');
    params.push(safeCategory);
  }
  if (safeSubcategory) {
    conditions.push('n.subcategory = ?');
    params.push(safeSubcategory);
  }

  const q = String(search || '').trim().toLowerCase();
  if (q) {
    conditions.push(`(
      lower(n.title) LIKE ?
      OR lower(n.content) LIKE ?
      OR EXISTS (
        SELECT 1
        FROM json_each(${safeTagsJson})
        WHERE lower(json_each.value) LIKE ?
      )
    )`);
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  const safeTag = String(tag || '').trim().toLowerCase();
  if (safeTag) {
    conditions.push(`EXISTS (
      SELECT 1
      FROM json_each(${safeTagsJson})
      WHERE lower(json_each.value) = ?
    )`);
    params.push(safeTag);
  }

  return {
    conditions,
    params,
    hasFolderScope: !!(safeCategory && safeSubcategory)
  };
}

function renderEmptyState({ hasFolderScope, hasAnyFilter }) {
  if (hasFolderScope) {
    return hasAnyFilter
      ? 'No notes matched this folder search.'
      : 'No notes in this subfolder yet.';
  }

  return hasAnyFilter
    ? 'No notes matched this search.'
    : 'No notes in your library yet.';
}

router.get('/', authMiddleware, async (c) => {
  const {
    page = '1',
    size = '10',
    category,
    subcategory,
    q,
    tag,
    id
  } = c.req.query();

  if (id) {
    if (!V.isUUID(id)) return jsonError(c, 'Invalid ID', 400);
    const row = await db.prepare('SELECT * FROM notes WHERE id = ?').bind(id).first();
    return c.json(toClientNote(row) || {});
  }

  const limit = V.safeInt(size, 10, 1, 50);
  const safePage = V.safeInt(page, 1, 1, 9999);
  const offset = (safePage - 1) * limit;
  const { conditions, params, hasFolderScope } = buildQuery(category, subcategory, q, tag);
  const whereClause = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';

  const listStmt = db.prepare(
    `SELECT id, title, category, subcategory, tags, created_at, updated_at
     FROM notes n${whereClause}
     ORDER BY n.title COLLATE NOCASE ASC, n.updated_at DESC, n.created_at DESC
     LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset);

  const totalStmt = db.prepare(
    `SELECT COUNT(*) AS total
     FROM notes n${whereClause}`
  ).bind(...params);

  const [listRes, totalRes] = await db.batch([listStmt, totalStmt]);
  const list = (listRes.results ?? []).map(toClientNote);
  const total = Number(totalRes.results?.[0]?.total ?? 0);

  if (c.req.header('HX-Request')) {
    const hasAnyFilter = !!String(q || '').trim() || !!String(tag || '').trim();
    const html = list.length
      ? renderArchiveList(list)
      : `<div class="loading-hint">${renderEmptyState({ hasFolderScope, hasAnyFilter })}</div>`;

    const totalPg = Math.max(1, Math.ceil(total / limit));
    return c.html(`${html}${renderPagination(safePage, totalPg)}`);
  }

  return c.json({ list, total });
});

export default router;
