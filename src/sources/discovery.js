import { discoverViaSitemap } from './sitemap.js';
import { discoverViaWpApi } from './wp-api.js';
import * as scama from './adapters/scama.js';
import * as allComment from './adapters/all-comment.js';
import { log } from '../logger.js';

const logger = log('обнаружение');

/**
 * Свои адаптеры под источники, у которых карта сайта не работает или структура
 * нестандартная. Ключ — sources.code, чтобы подключение нового сайта сводилось
 * к строке в БД плюс, при необходимости, файлу в adapters/.
 */
const ADAPTERS = {
  scama: scama.discover,
  'all-comment': allComment.discover,
};

/**
 * Единая точка обнаружения материалов источника.
 * @returns {Promise<Array<{url, lastmod, title, topicHint, snippet?}>>}
 */
export async function discoverSource(source, { since, limit }) {
  const adapter = ADAPTERS[source.code];

  if (source.discovery === 'custom' || adapter) {
    if (!adapter) {
      throw new Error(`Для источника ${source.code} задан режим custom, но адаптер не найден`);
    }
    logger.debug({ источник: source.code }, `${source.code}: обнаружение своим адаптером`);
    return adapter(source, { since, limit });
  }

  if (source.discovery === 'sitemap') {
    return discoverViaSitemap(source, { since, limit });
  }

  // Резерв: sitemap не задан, но WP API есть
  logger.warn({ источник: source.code }, `${source.code}: неизвестный режим обнаружения, пробуем WP API`);
  return discoverViaWpApi(source, { since, limit });
}
