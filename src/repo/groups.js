import { query } from '../db/pool.js';

/**
 * Группы ВК. Список приходит из postmypost — числовые id клиент руками не вводит.
 *
 * Две особенности, которые задают форму этого файла:
 *
 * 1. **Удаление мягкое** (`deleted_at`). По группе есть история публикаций, и физическое
 *    удаление строки её уносит. «Удалить» в панели значит «убрать из списка и из постинга»;
 *    строку можно вернуть кнопкой, история всё это время цела.
 * 2. **Все выборки для работы фильтруют удалённые.** Единственное исключение —
 *    `findAnyById`: он нужен, чтобы показать группу в истории публикаций и чтобы
 *    восстановление находило скрытую строку.
 */

/** Записать/обновить группу из ответа /accounts postmypost. */
export async function upsertFromPmp(account, { postsPerDay } = {}) {
  const { rows } = await query(
    `INSERT INTO groups (pmp_account_id, name, login, external_id, connection_status,
                         posts_per_day, synced_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, 10), now())
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
      postsPerDay ?? null,
    ],
  );
  // posts_per_day при обновлении намеренно не перезаписывается: это значение задаёт
  // клиент в панели, а синхронизация не должна его сбрасывать к дефолту.
  return rows[0];
}

/**
 * Список для панели: видимые группы + счётчики публикаций (всего и за сегодня).
 * «За сегодня» считается по МСК — в этом часовом поясе живёт всё расписание проекта.
 */
export async function listAll() {
  const { rows } = await query(
    `SELECT g.*,
            (SELECT count(*) FROM publications p
              WHERE p.group_id = g.id)::int AS publications,
            (SELECT count(*) FROM publications p
              WHERE p.group_id = g.id
                AND p.error IS NULL
                AND p.pmp_publication_id IS NOT NULL
                AND (p.created_at AT TIME ZONE 'Europe/Moscow')::date
                    = (now() AT TIME ZONE 'Europe/Moscow')::date)::int AS published_today
       FROM groups g
      WHERE g.deleted_at IS NULL
      ORDER BY g.name`,
  );
  return rows;
}

/** Скрытые группы: показываем отдельным списком, чтобы удаление можно было отменить. */
export async function listDeleted() {
  const { rows } = await query(
    `SELECT g.*,
            (SELECT count(*) FROM publications p WHERE p.group_id = g.id)::int AS publications
       FROM groups g
      WHERE g.deleted_at IS NOT NULL
      ORDER BY g.name`,
  );
  return rows;
}

export async function listActive() {
  const { rows } = await query(
    'SELECT * FROM groups WHERE is_active AND deleted_at IS NULL ORDER BY name',
  );
  return rows;
}

export async function findById(id) {
  const { rows } = await query('SELECT * FROM groups WHERE id = $1 AND deleted_at IS NULL', [id]);
  return rows[0] ?? null;
}

/** Группа вместе со скрытыми — для истории публикаций и для восстановления. */
export async function findAnyById(id) {
  const { rows } = await query('SELECT * FROM groups WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function findByIds(ids) {
  if (!ids.length) return [];
  const { rows } = await query(
    'SELECT * FROM groups WHERE id = ANY($1::int[]) AND deleted_at IS NULL ORDER BY name',
    [ids],
  );
  return rows;
}

export async function setActive(id, isActive) {
  await query('UPDATE groups SET is_active = $2 WHERE id = $1', [id, isActive]);
}

/**
 * Постов в день на группу. Ограничение 0-100 стоит и в CHECK схемы, но проверяем здесь:
 * ошибка ввода должна быть понятной фразой, а не «violates check constraint».
 */
export async function setPostsPerDay(id, value) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number) || number < 0 || number > 100) {
    throw new Error('Постов в день: нужно целое число от 0 до 100');
  }
  const { rows } = await query(
    'UPDATE groups SET posts_per_day = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING *',
    [id, number],
  );
  if (!rows[0]) throw new Error(`Группы #${id} нет`);
  return rows[0];
}

/**
 * Обновить состояние подключения. Держим его в БД, чтобы в панели было видно
 * отвалившийся аккаунт, не дожидаясь неудачной публикации.
 */
export async function setConnectionStatus(id, status) {
  await query('UPDATE groups SET connection_status = $2, synced_at = now() WHERE id = $1', [id, status]);
}

/** Мягкое удаление: из списка и из постинга группа уходит, история остаётся. */
export async function softDelete(id) {
  const { rows } = await query(
    `UPDATE groups SET deleted_at = now(), is_active = false
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING *`,
    [id],
  );
  return rows[0] ?? null;
}

/** Вернуть скрытую группу. Включать её обратно в постинг клиент решает отдельно. */
export async function restore(id) {
  const { rows } = await query(
    `UPDATE groups SET deleted_at = NULL, is_active = false
      WHERE id = $1 AND deleted_at IS NOT NULL
      RETURNING *`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Сколько постов уже уехало в группу сегодня (МСК) — база дневного лимита.
 * Считаются только успешные публикации: сбой лимит не расходует.
 */
export async function publishedToday(id) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM publications
      WHERE group_id = $1
        AND error IS NULL
        AND pmp_publication_id IS NOT NULL
        AND (created_at AT TIME ZONE 'Europe/Moscow')::date
            = (now() AT TIME ZONE 'Europe/Moscow')::date`,
    [id],
  );
  return rows[0].n;
}

export async function countAll() {
  const { rows } = await query(
    `SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS total,
            count(*) FILTER (WHERE is_active AND deleted_at IS NULL)::int AS active,
            count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS deleted
       FROM groups`,
  );
  return rows[0];
}
