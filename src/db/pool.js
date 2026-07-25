import pg from 'pg';
import { config } from '../config.js';
import { log, errFields } from '../logger.js';

const logger = log('БД');

export const pool = new pg.Pool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (error) => {
  logger.error(errFields(error), 'Ошибка простаивающего соединения с БД');
});

/** Запрос с логом: текст (сжатый), длительность, число строк. */
export async function query(text, params = []) {
  const startedAt = process.hrtime.bigint();
  try {
    const result = await pool.query(text, params);
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.debug(
      { sql: text.replace(/\s+/g, ' ').trim().slice(0, 200), rows: result.rowCount, ms: Math.round(ms) },
      'SQL-запрос выполнен',
    );
    return result;
  } catch (error) {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.error(
      { sql: text.replace(/\s+/g, ' ').trim().slice(0, 200), params, ms: Math.round(ms), ...errFields(error) },
      'SQL-запрос упал',
    );
    throw error;
  }
}

/** Транзакция: коммит при успехе, откат при любой ошибке. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Ждём, пока БД примет соединение. Контейнер app стартует раньше postgres даже
 * с depends_on: condition: service_healthy — на медленной машине healthcheck может
 * успеть раньше, чем postgres реально готов принимать запросы.
 */
export async function waitForDatabase() {
  const { connectRetries, connectRetryDelayMs } = config.db;
  for (let attempt = 1; attempt <= connectRetries; attempt += 1) {
    try {
      const client = await pool.connect();
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
      }
      logger.info({ host: config.db.host, db: config.db.database, attempt }, 'Соединение с БД установлено');
      return;
    } catch (error) {
      if (attempt === connectRetries) {
        logger.error(errFields(error), `БД не ответила за ${connectRetries} попыток — останавливаемся`);
        throw error;
      }
      logger.warn(
        { attempt, retries: connectRetries, message: error.message },
        `БД пока недоступна, повтор через ${connectRetryDelayMs} мс`,
      );
      await new Promise((resolve) => setTimeout(resolve, connectRetryDelayMs));
    }
  }
}

export async function closePool() {
  await pool.end();
  logger.info('Пул соединений с БД закрыт');
}
