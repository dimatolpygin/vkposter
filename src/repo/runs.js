import { query } from '../db/pool.js';

export async function startRun({ requestId, kind, meta = {} }) {
  const { rows } = await query(
    `INSERT INTO runs (request_id, kind, meta) VALUES ($1, $2, $3) RETURNING id`,
    [requestId, kind, meta],
  );
  return rows[0].id;
}

export async function finishRun(id, { status, found = 0, generated = 0, published = 0, error = null, meta }) {
  await query(
    `UPDATE runs
        SET status = $2, finished_at = now(), found = $3, generated = $4, published = $5,
            error = $6, meta = COALESCE($7, meta)
      WHERE id = $1`,
    [id, status, found, generated, published, error ? String(error).slice(0, 2000) : null, meta ?? null],
  );
}

export async function listRecent(limit = 30) {
  const { rows } = await query(
    `SELECT * FROM runs ORDER BY started_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function lastRun() {
  const { rows } = await query('SELECT * FROM runs ORDER BY started_at DESC LIMIT 1');
  return rows[0] ?? null;
}
