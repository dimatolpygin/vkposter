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
