import express from 'express';
import { config } from '../config.js';
import { log, errFields } from '../logger.js';
import { getRequestId } from '../context.js';
import { requestContext } from './middleware/request-context.js';
import { healthRouter } from './routes/health.js';
import { debugRouter } from './routes/debug.js';

const logger = log('http');

export function createApp() {
  const app = express();

  app.set('trust proxy', 1); // на проде за nginx/Caddy — иначе req.ip врёт
  app.disable('x-powered-by');

  app.use(requestContext());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  app.use(healthRouter());

  if (!config.isProd) {
    app.use(debugRouter());
    logger.warn('Подключены отладочные роуты /_debug/* (только вне production)');
  }

  // Заглушка корня — панель появится на этапе 1.
  app.get('/', (_req, res) => {
    res.type('text/plain; charset=utf-8').send(
      'vkposter — автопостинг ВК. Панель управления появится на этапе 1. Проверка: GET /health\n',
    );
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'Не найдено', path: req.originalUrl, request_id: getRequestId() });
  });

  // eslint-disable-next-line no-unused-vars -- четвёртый аргумент обязателен для Express
  app.use((error, req, res, _next) => {
    logger.error(
      { method: req.method, url: req.originalUrl, ...errFields(error) },
      'Необработанная ошибка при обработке запроса',
    );
    res.status(500).json({ error: 'Внутренняя ошибка', request_id: getRequestId() });
  });

  return app;
}
