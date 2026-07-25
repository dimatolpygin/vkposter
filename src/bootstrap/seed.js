import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { log } from '../logger.js';
import * as users from '../repo/users.js';
import * as settings from '../repo/settings.js';

const logger = log('сид');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Промт клиента лежит файлом в репозитории, но рабочая копия — в БД: клиент правит её
 * в панели без деплоя. Файл используется только как первичное значение.
 */
const PROMPT_SEEDS = [
  {
    key: 'post_prompt',
    title: 'Промт генерации текста поста',
    file: 'docs/prompts/post_prompt.seed.txt',
  },
  {
    key: 'image_prompt',
    title: 'Промт генерации обложки',
    inline:
      'создать обложку по теме - "{{тема}}". стиль ютуб обложка. текст на обложке русский. ' +
      'надо учесть что обложка будет отображаться маленькой, поэтому сделай крупный читаемый текст, ' +
      '2-4 слова максимум, без мелких деталей. Главный текст должен читаться даже при уменьшении ' +
      'до 160 px по ширине.',
  },
];

async function seedPrompts() {
  for (const seed of PROMPT_SEEDS) {
    let value = seed.inline;
    if (seed.file) {
      try {
        value = await readFile(path.join(ROOT, seed.file), 'utf8');
      } catch (error) {
        logger.warn(
          { файл: seed.file, message: error.message },
          `Файл промта не найден — ключ ${seed.key} остаётся пустым, заполнить в панели`,
        );
        value = '';
      }
    }
    const inserted = await settings.setIfAbsent(seed.key, value, seed.title);
    if (inserted) {
      logger.info({ ключ: seed.key, символов: value.length }, `Промт засеян: ${seed.key}`);
    }
  }
}

/**
 * Аккаунт панели создаётся один раз из ADMIN_LOGIN/ADMIN_PASSWORD. Дальше пароль живёт
 * в БД и меняется только через панель — переменная окружения его не перезатирает.
 */
async function seedAdmin() {
  const existing = await users.countUsers();
  if (existing > 0) {
    logger.debug({ пользователей: existing }, 'Аккаунт панели уже создан, сид пропущен');
    return;
  }
  if (!config.admin.initialPassword) {
    logger.error(
      'Нет ни одного аккаунта панели, а ADMIN_PASSWORD не задан. Задайте ADMIN_PASSWORD в .env и перезапустите.',
    );
    return;
  }
  const created = await users.createUser(config.admin.login, config.admin.initialPassword);
  if (created) {
    logger.info({ логин: created.login }, `Создан аккаунт панели: ${created.login}`);
  }
}

export async function runSeeds() {
  await seedAdmin();
  await seedPrompts();
}
