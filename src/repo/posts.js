import { query } from '../db/pool.js';

/** Сгенерированные посты. */

export async function create(row) {
  const { rows } = await query(
    `INSERT INTO posts (article_id, title, body, char_count, model, provider, prompt_version,
                        tokens_in, tokens_out, cost_usd, latency_ms, attempts, topic_key,
                        request_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'ready')
     RETURNING *`,
    [
      row.articleId ?? null,
      row.title,
      row.body,
      row.body.length,
      row.model ?? null,
      row.provider ?? null,
      row.promptVersion ?? null,
      row.tokensIn ?? null,
      row.tokensOut ?? null,
      row.costUsd ?? null,
      row.latencyMs ?? null,
      row.attempts ?? 1,
      row.topicKey ?? null,
      row.requestId ?? null,
    ],
  );
  return rows[0];
}

export async function createFailed(row) {
  const { rows } = await query(
    `INSERT INTO posts (article_id, title, body, char_count, model, prompt_version, attempts,
                        topic_key, request_id, status, error)
     VALUES ($1, $2, '', 0, $3, $4, $5, $6, $7, 'failed', $8)
     RETURNING *`,
    [
      row.articleId ?? null,
      row.title ?? '(не сгенерирован)',
      row.model ?? null,
      row.promptVersion ?? null,
      row.attempts ?? 1,
      row.topicKey ?? null,
      row.requestId ?? null,
      String(row.error).slice(0, 1000),
    ],
  );
  return rows[0];
}

export async function findById(id) {
  const { rows } = await query(
    `SELECT p.*, a.url AS article_url, a.topic_name, s.code AS source_code
       FROM posts p
       LEFT JOIN articles a ON a.id = p.article_id
       LEFT JOIN sources s ON s.id = a.source_id
      WHERE p.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listRecent(limit = 30) {
  const { rows } = await query(
    `SELECT p.id, p.title, p.char_count, p.status, p.model, p.provider, p.cost_usd,
            p.latency_ms, p.attempts, p.topic_key, p.created_at, p.error,
            a.url AS article_url, s.code AS source_code
       FROM posts p
       LEFT JOIN articles a ON a.id = p.article_id
       LEFT JOIN sources s ON s.id = a.source_id
      ORDER BY p.id DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

/**
 * Материал для следующей генерации: свежий, с известной темой, ещё не отработанный.
 * Темы, по которым пост уже есть, исключаются — это и есть учёт «уже публиковали».
 */
export async function nextArticleForGeneration() {
  const { rows } = await query(
    `SELECT a.id, a.url, a.title, a.content, a.topic_key, a.topic_name,
            COALESCE(a.published_at, a.lastmod) AS published_at,
            s.code AS source_code, s.content_mode
       FROM articles a
       JOIN sources s ON s.id = a.source_id
      WHERE a.status IN ('new', 'fetched')
        AND a.topic_key IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.topic_key = a.topic_key AND p.status <> 'failed')
        AND (s.content_mode = 'topic_only' OR a.content IS NOT NULL)
      ORDER BY COALESCE(a.published_at, a.lastmod) DESC NULLS LAST
      LIMIT 1`,
  );
  return rows[0] ?? null;
}

export async function findArticleForGeneration(articleId) {
  const { rows } = await query(
    `SELECT a.id, a.url, a.title, a.content, a.topic_key, a.topic_name,
            COALESCE(a.published_at, a.lastmod) AS published_at,
            s.code AS source_code, s.content_mode
       FROM articles a
       JOIN sources s ON s.id = a.source_id
      WHERE a.id = $1`,
    [articleId],
  );
  return rows[0] ?? null;
}

export async function markArticleQueued(articleId) {
  await query(`UPDATE articles SET status = 'queued' WHERE id = $1`, [articleId]);
}

export async function countAll() {
  const { rows } = await query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'failed')::int AS failed,
            COALESCE(sum(cost_usd), 0)::numeric AS cost
       FROM posts`,
  );
  return rows[0];
}
