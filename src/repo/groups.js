import { query } from '../db/pool.js';

/**
 * Группы ВК. Список приходит из postmypost — числовые id клиент руками не вводит.
 * Полное управление (вкл/выкл, постов в день) появится в панели на этапе 7; здесь
 * минимум, без которого нечего публиковать.
 */

/** Записать/обновить группу из ответа /accounts postmypost. */
export async function upsertFromPmp(account) {
  const { rows } = await query(
    `INSERT INTO groups (pmp_account_id, name, login, external_id, connection_status, synced_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (pmp_account_id) DO UPDATE
        SET name = EXCLUDED.name,
            login = EXCLUDED.login,
            external_id = EXCLUDED.external_id,
            connection_status = EXCLUDED.connection_status,
            synced_at = now()
     RETURNING *, (xmax = 0) AS inserted`,
    [
      account.id,
      account.name ?? `Группа ${account.id}`,
      account.login ?? null,
      account.external_id ?? null,
      account.connection_status ?? null,
    ],
  );
  return rows[0];
}

export async function listAll() {
  const { rows } = await query(
    `SELECT g.*,
            (SELECT count(*) FROM publications p WHERE p.group_id = g.id)::int AS publications
       FROM groups g
      ORDER BY g.name`,
  );
  return rows;
}

export async function listActive() {
  const { rows } = await query('SELECT * FROM groups WHERE is_active ORDER BY name');
  return rows;
}

export async function findById(id) {
  const { rows } = await query('SELECT * FROM groups WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function findByIds(ids) {
  if (!ids.length) return [];
  const { rows } = await query('SELECT * FROM groups WHERE id = ANY($1::int[]) ORDER BY name', [ids]);
  return rows;
}

export async function setActive(id, isActive) {
  await query('UPDATE groups SET is_active = $2 WHERE id = $1', [id, isActive]);
}

/**
 * Обновить состояние подключения. Держим его в БД, чтобы в панели было видно
 * отвалившийся аккаунт, не дожидаясь неудачной публикации.
 */
export async function setConnectionStatus(id, status) {
  await query('UPDATE groups SET connection_status = $2, synced_at = now() WHERE id = $1', [id, status]);
}

export async function countAll() {
  const { rows } = await query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE is_active)::int AS active
       FROM groups`,
  );
  return rows[0];
}
