import { request } from './http-client.js';
import { config } from '../config.js';
import { log } from '../logger.js';

const logger = log('firecrawl');

/**
 * Клиент firecrawl. Бесплатный лимит — 1000 запросов в месяц на весь проект,
 * поэтому обращаемся к нему только там, где иначе никак:
 *  - scama.net отдаёт 403 на прямой запрос, а через firecrawl открывается;
 *  - подстраховка, если у WP-источника закрылся REST API.
 *
 * Каждый вызов считается расходом лимита, поэтому он логируется отдельной строкой.
 */
export function isConfigured() {
  return Boolean(config.firecrawl.apiKey);
}

/**
 * Забирает страницу в markdown.
 * @returns {Promise<{markdown: string, title: string|null, links: string[]}>}
 */
export async function scrape(url, { onlyMainContent = true, includeLinks = false } = {}) {
  if (!isConfigured()) {
    throw new Error('FIRECRAWL_API_KEY не задан — извлечение через firecrawl недоступно');
  }

  const formats = ['markdown'];
  if (includeLinks) formats.push('links');

  logger.info({ url }, `Расход лимита firecrawl: запрос страницы ${url}`);

  const body = await request(`${config.firecrawl.baseUrl}/scrape`, {
    method: 'POST',
    label: 'firecrawl',
    headers: { Authorization: `Bearer ${config.firecrawl.apiKey}` },
    json: { url, formats, onlyMainContent },
    timeoutMs: config.firecrawl.timeoutMs,
    retries: 2,
    baseDelayMs: 3000,
  });

  if (!body?.success) {
    throw new Error(`firecrawl вернул неуспешный ответ: ${JSON.stringify(body).slice(0, 300)}`);
  }

  const data = body.data ?? {};
  return {
    markdown: data.markdown ?? '',
    title: data.metadata?.title ?? null,
    links: Array.isArray(data.links) ? data.links : [],
  };
}

/**
 * Поиск в вебе с текстом найденных страниц (`POST /search`).
 *
 * Один вызов заменяет «поиск + N отдельных scrape»: если передать `scrapeOptions`,
 * firecrawl возвращает результаты уже с markdown. Экономит и лимит, и время.
 *
 * Расход считается по числу результатов, а не по числу вызовов, поэтому `limit`
 * задаётся настройкой панели, а не константой: клиенту нужно управлять тратой.
 *
 * @param {string} query поисковый запрос
 * @param {{limit?: number, withText?: boolean, timeoutMs?: number}} [options]
 * @returns {Promise<Array<{url: string, title: string|null, description: string|null, markdown: string}>>}
 */
export async function search(query, { limit = 3, withText = true, timeoutMs } = {}) {
  if (!isConfigured()) {
    throw new Error('FIRECRAWL_API_KEY не задан — поиск материала недоступен');
  }

  logger.info(
    { запрос: query, результатов: limit },
    `Расход лимита firecrawl: поиск «${query}» (до ${limit} результатов)`,
  );

  const json = { query, limit };
  if (withText) {
    // Формат объектом, а не строкой: в v2 это единственная форма, которая
    // возвращает markdown вместе с результатами поиска.
    json.scrapeOptions = { formats: [{ type: 'markdown' }], onlyMainContent: true };
  }

  const body = await request(`${config.firecrawl.baseUrl}/search`, {
    method: 'POST',
    label: 'firecrawl',
    headers: { Authorization: `Bearer ${config.firecrawl.apiKey}` },
    json,
    // Поиск с попутным скрейпом идёт дольше одной страницы: это N страниц подряд.
    timeoutMs: timeoutMs ?? config.firecrawl.timeoutMs * 2,
    // Повтор поиска — это повторный расход лимита. Один дубль терпим, больше нет.
    retries: 1,
    baseDelayMs: 3000,
  });

  if (!body?.success) {
    throw new Error(`firecrawl (поиск) вернул неуспешный ответ: ${JSON.stringify(body).slice(0, 300)}`);
  }

  // Выдача лежит в data.web; на всякий случай принимаем и плоский массив.
  const raw = Array.isArray(body.data) ? body.data : (body.data?.web ?? []);
  return raw
    .filter((item) => item?.url)
    .map((item) => ({
      url: item.url,
      title: item.title ?? null,
      description: item.description ?? null,
      markdown: item.markdown ?? '',
    }));
}
