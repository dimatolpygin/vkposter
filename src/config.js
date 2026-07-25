import 'dotenv/config';

/** Читает переменную окружения, падает на старте, если обязательная не задана. */
function env(name, { required = false, fallback = undefined } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    if (required) {
      throw new Error(`Не задана обязательная переменная окружения ${name} (см. .env.example)`);
    }
    return fallback;
  }
  return raw;
}

function envInt(name, fallback) {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Переменная окружения ${name} должна быть целым числом, получено: ${raw}`);
  }
  return parsed;
}

function envBool(name, fallback) {
  const raw = env(name);
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'да'].includes(raw.toLowerCase());
}

export const config = {
  nodeEnv: env('NODE_ENV', { fallback: 'development' }),
  get isProd() {
    return this.nodeEnv === 'production';
  },

  http: {
    port: envInt('PORT', 3000),
  },

  log: {
    level: env('LOG_LEVEL', { fallback: 'info' }),
    pretty: envBool('LOG_PRETTY', true),
  },

  db: {
    // В докере хост — имя сервиса postgres; локально — localhost.
    host: env('POSTGRES_HOST', { fallback: 'postgres' }),
    port: envInt('POSTGRES_PORT', 5432),
    user: env('POSTGRES_USER', { required: true }),
    password: env('POSTGRES_PASSWORD', { required: true }),
    database: env('POSTGRES_DB', { required: true }),
    // Ждём готовности БД на старте: контейнер app может подняться раньше postgres.
    connectRetries: envInt('DB_CONNECT_RETRIES', 30),
    connectRetryDelayMs: envInt('DB_CONNECT_RETRY_DELAY_MS', 2000),
  },

  session: {
    secret: env('SESSION_SECRET', { required: true }),
  },

  // Первичная установка аккаунта панели. Дальше пароль живёт в БД и меняется в панели.
  admin: {
    login: env('ADMIN_LOGIN', { fallback: 'admin' }),
    initialPassword: env('ADMIN_PASSWORD'),
  },

  // Публичный базовый URL — нужен на этапе 5, чтобы отдавать картинки в postmypost.
  publicBaseUrl: env('PUBLIC_BASE_URL', { fallback: 'http://localhost:3000' }),
};
