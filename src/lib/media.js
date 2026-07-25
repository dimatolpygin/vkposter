import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../logger.js';

const logger = log('медиа');

/**
 * Своё хранилище картинок.
 *
 * Зачем не отдавать ссылку провайдера: результат kie.ai лежит на `tempfile.aiquickdraw.com`
 * и живёт минуты. Публикация в ВК отложенная — к моменту постинга ссылка мёртвая,
 * а postmypost скачивает картинку сам, по URL, в момент публикации. Поэтому файл
 * перекладывается в том `media` и отдаётся с нашего домена.
 *
 * Раскладка по месяцам (`media/2026-07/...`): чистить архив за старый месяц одной командой.
 */

const EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

/** Имя месяца в МСК — контейнер живёт в Europe/Moscow, отдельный формат не нужен. */
function monthDir(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function extensionFor(contentType, sourceUrl) {
  const byType = EXTENSIONS[String(contentType).split(';')[0].trim().toLowerCase()];
  if (byType) return byType;
  const fromUrl = sourceUrl ? path.extname(new URL(sourceUrl).pathname).toLowerCase() : '';
  return /^\.(png|jpe?g|webp)$/.test(fromUrl) ? fromUrl : '.png';
}

/**
 * Сохранить обложку поста.
 *
 * @returns {Promise<{path: string, relative: string, url: string, bytes: number}>}
 *          `path` — абсолютный путь на диске, `url` — публичный адрес для postmypost.
 */
export async function savePostImage({ postId, buffer, contentType, sourceUrl }) {
  const month = monthDir();
  const dir = path.join(config.mediaDir, month);
  await mkdir(dir, { recursive: true });

  // Имя со временем: повторная генерация обложки для того же поста не затирает прежнюю,
  // а браузер не показывает старую картинку из кеша по прежнему адресу.
  const name = `post-${postId}-${Date.now()}${extensionFor(contentType, sourceUrl)}`;
  const absolute = path.join(dir, name);
  await writeFile(absolute, buffer);

  const relative = `${month}/${name}`;
  const url = `${config.publicBaseUrl.replace(/\/+$/, '')}/media/${relative}`;

  logger.info(
    { пост: postId, путь: absolute, байт: buffer.length, url },
    `Обложка сохранена: ${absolute} (${Math.round(buffer.length / 1024)} КБ)`,
  );

  return { path: absolute, relative, url, bytes: buffer.length };
}

export function mediaRoot() {
  return config.mediaDir;
}
