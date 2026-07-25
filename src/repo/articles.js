import { query } from '../db/pool.js';
import { normalizeUrl } from '../lib/url.js';

/**
 * Сохранение найденного материала. Дедуп по url_norm держит уникальный индекс:
 * ON CONFLICT DO NOTHING означает «уже видели — не трогаем».
 * @returns {Promise<'added'|'duplicate'|'invalid'>}
 */
export async function saveCandidate(sourceId, candidate) {
  const urlNorm = normalizeUrl(candidate.url);
  if (!urlNorm) return 'invalid';

  const { rowCount } = await query(
    `INSERT INTO articles (source_id, url, url_norm, title, lastmod, status)
     VALUES ($1, $2, $3, $4, $5, 'new')
     ON CONFLICT (url_norm) DO NOTHING`,
    [sourceId, candidate.url, urlNorm, candidate.title ?? null, candidate.lastmod ?? null],
  );
  return rowCount > 0 ? 'added' : 'duplicate';
}

/**
 * Материалы, которым нужен текст: только режим text и только те, где текста ещё нет.
 * Свежие вперёд — постинг идёт от свежих к старым.
 */
export async function listPendingExtraction(sourceId, limit) {
  const { rows } = await query(
    `SELECT a.*, s.code AS source_code, s.base_url, s.fetch_via, s.content_mode
       FROM articles a
       JOIN sources s ON s.id = a.source_id
      WHERE a.source_id = $1
        AND s.content_mode = 'text'
        AND a.status = 'new'
        AND a.content IS NULL
      ORDER BY COALESCE(a.published_at, a.lastmod) DESC NULLS LAST
      LIMIT $2`,
    [sourceId, limit],
  );
  return rows;
}

export async function saveContent(id, { title, text, publishedAt = null }) {
  await query(
    `UPDATE articles
        SET content = $2,
            title = COALESCE(NULLIF($3, ''), title),
            published_at = COALESCE($4, published_at),
            content_fetched_at = now(),
            status = 'fetched',
            skip_reason = NULL
      WHERE id = $1`,
    [id, text, title ?? '', publishedAt],
  );
}

export async function markFailed(id, reason) {
  await query(`UPDATE articles SET status = 'failed', skip_reason = $2 WHERE id = $1`, [
    id,
    String(reason).slice(0, 500),
  ]);
}

/** Материалы в режиме «только тема» текста не требуют — сразу считаем готовыми. */
export async function markTopicOnlyReady(sourceId) {
  const { rowCount } = await query(
    `UPDATE articles a
        SET status = 'fetched'
      WHERE a.source_id = $1
        AND a.status = 'new'
        AND EXISTS (SELECT 1 FROM sources s WHERE s.id = a.source_id AND s.content_mode = 'topic_only')`,
    [sourceId],
  );
  return rowCount;
}

export async function statsBySource() {
  const { rows } = await query(`
    SELECT s.id AS source_id,
           count(a.id)::int                                        AS total,
           count(a.id) FILTER (WHERE a.content IS NOT NULL)::int    AS with_text,
           count(a.id) FILTER (WHERE a.status = 'failed')::int       AS failed,
           max(COALESCE(a.published_at, a.lastmod))                 AS newest
      FROM sources s
      LEFT JOIN articles a ON a.source_id = s.id
     GROUP BY s.id
  `);
  return new Map(rows.map((row) => [row.source_id, row]));
}

export async function listRecent(limit = 40, sourceId = null) {
  const { rows } = await query(
    `SELECT a.id, a.url, a.title, COALESCE(a.published_at, a.lastmod) AS lastmod, a.status, a.skip_reason,
            a.content IS NOT NULL AS has_text,
            length(a.content) AS text_len,
            s.code AS source_code, s.content_mode
       FROM articles a
       JOIN sources s ON s.id = a.source_id
      WHERE ($2::int IS NULL OR a.source_id = $2)
      ORDER BY COALESCE(a.published_at, a.lastmod) DESC NULLS LAST, a.id DESC
      LIMIT $1`,
    [limit, sourceId],
  );
  return rows;
}

export async function countAll() {
  const { rows } = await query('SELECT count(*)::int AS count FROM articles');
  return rows[0].count;
}
