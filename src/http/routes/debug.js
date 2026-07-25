import { Router } from 'express';
import { config } from '../../config.js';
import { request, HttpError } from '../../lib/http-client.js';
import { getRequestId } from '../../context.js';
import { log, errFields } from '../../logger.js';

const logger = log('отладка');

/**
 * Только для dev. Нужен для приёмки этапа 0: даёт воспроизвести ошибку внешнего запроса
 * и убедиться, что в лог попали статус, тело ответа и request-id.
 * В production этот роутер не подключается (см. app.js).
 */
export function debugRouter() {
  const router = Router();

  // Заглушка провайдера: отдаёт заданный статус с телом. Локальная, чтобы проверка
  // не зависела от доступности внешних сервисов из контейнера.
  router.all('/_debug/echo/:status', (req, res) => {
    const status = Number.parseInt(req.params.status, 10) || 500;
    res
      .status(status)
      .json({ error: 'Заглушка провайдера', status, message: `Сымитирован ответ ${status}` });
  });

  // GET /_debug/http?status=503 — прогон через http-client с ретраями по локальной заглушке.
  // GET /_debug/http?url=... — произвольный URL.
  router.get('/_debug/http', async (req, res) => {
    const status = req.query.status ?? '503';
    const url =
      req.query.url ?? `http://127.0.0.1:${config.http.port}/_debug/echo/${encodeURIComponent(status)}`;
    const retries = Number.parseInt(req.query.retries ?? '1', 10);

    try {
      const body = await request(url, { label: 'отладка', retries, timeoutMs: 8000 });
      res.json({ ok: true, request_id: getRequestId(), body: String(body).slice(0, 300) });
    } catch (error) {
      logger.error(errFields(error), 'Отладочный внешний запрос упал — так и задумано');
      res.status(502).json({
        ok: false,
        request_id: getRequestId(),
        status: error instanceof HttpError ? error.status : null,
        body: error instanceof HttpError ? String(error.body).slice(0, 300) : null,
        message: error.message,
      });
    }
  });

  // GET /_debug/boom — необработанное исключение внутри обработчика (проверка error-handler).
  router.get('/_debug/boom', () => {
    throw new Error('Искусственная ошибка для проверки обработчика');
  });

  return router;
}
