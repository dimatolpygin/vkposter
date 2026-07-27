import { request } from '../lib/http-client.js';
import { config } from '../config.js';
import { log } from '../logger.js';

const logger = log('sitemap');

/**
 * Чтение sitemap. Основной способ обнаружения новых материалов — карта сайта,
 * а не краулинг: она отдаёт готовый список URL с датой изменения.
 *
 * Парсер на регулярках сознательно: sitemap — плоский предсказуемый XML, тянуть
 * зависимость ради двух тегов не нужно.
 */

function decodeXmlEntities(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&#039;', "'");
}

/** Разбирает и <sitemapindex>, и <urlset> — структура записей одинаковая. */
export function parseSitemap(xml) {
  const isIndex = /<sitemapindex/i.test(xml);
  const blockRe = isIndex ? /<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi : /<url\b[^>]*>([\s\S]*?)<\/url>/gi;

  const entries = [];
  for (const match of xml.matchAll(blockRe)) {
    const block = match[1];
    const loc = /<loc>\s*([\s\S]*?)\s*<\/loc>/i.exec(block)?.[1];
    if (!loc) continue;
    const lastmodRaw = /<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/i.exec(block)?.[1];
    const lastmod = lastmodRaw ? new Date(lastmodRaw) : null;
    entries.push({
      loc: decodeXmlEntities(loc),
      lastmod: lastmod && !Number.isNaN(lastmod.getTime()) ? lastmod : null,
    });
  }
  return { isIndex, entries };
}

async function fetchXml(url, label) {
  return request(url, {
    label,
    headers: { 'User-Agent': config.userAgent, Accept: 'application/xml,text/xml,*/*' },
    timeoutMs: 30_000,
    retries: 2,
    raw: true,
  }).then((response) => response.text());
}

/**
 * Возвращает список материалов из карты сайта источника.
 *
 * Ключевое решение: какой именно дочерний sitemap несёт свежее, определяется по
 * его lastmod в индексе, а НЕ по номеру в имени файла. На пресейле считалось, что
 * у cryptorussia свежее лежит в services-sitemap, а по факту сейчас — и в
 * post-sitemap.xml, и в services-sitemap.xml, тогда как архив 2024 — в нумерованных
 * файлах обоих типов. Сортировка по lastmod устойчива к таким переменам.
 */
export async function discoverViaSitemap(source, { since, until = null, limit }) {
  const label = `sitemap:${source.code}`;
  const indexUrl = source.sitemap_url ?? `${source.base_url}/sitemap.xml`;
  const patterns = (source.sitemap_pattern ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const indexXml = await fetchXml(indexUrl, label);
  const parsedIndex = parseSitemap(indexXml);

  // Источник может отдать сразу urlset вместо индекса — обрабатываем оба случая.
  let children;
  if (parsedIndex.isIndex) {
    children = parsedIndex.entries.filter((entry) =>
      patterns.length === 0 ? true : patterns.some((pattern) => entry.loc.includes(pattern)),
    );
    // Сначала самые свежие; файлы без lastmod проверяем в конце — вслепую отбросить нельзя.
    children.sort((a, b) => (b.lastmod?.getTime() ?? 0) - (a.lastmod?.getTime() ?? 0));
    const fresh = children.filter((entry) => !entry.lastmod || entry.lastmod >= since);
    logger.info(
      { источник: source.code, всего: children.length, свежих: fresh.length },
      `${source.code}: в индексе ${children.length} подходящих карт, свежих по lastmod — ${fresh.length}`,
    );
    children = fresh;
  } else {
    children = [{ loc: indexUrl, lastmod: null }];
  }

  const found = [];
  for (const child of children) {
    if (found.length >= limit) break;
    const xml = parsedIndex.isIndex ? await fetchXml(child.loc, label) : indexXml;
    const { entries } = parseSitemap(xml);
    // Верхняя граница применяется только к самим материалам, но не к выбору дочерних
    // карт: `lastmod` карты — это когда её последний раз перезаписали, и свежая карта
    // спокойно содержит статьи двухлетней давности.
    const fresh = entries.filter(
      (entry) => entry.lastmod && entry.lastmod >= since && (!until || entry.lastmod <= until),
    );
    logger.debug(
      { карта: child.loc, всего: entries.length, свежих: fresh.length },
      `${child.loc}: ${fresh.length} свежих из ${entries.length}`,
    );
    found.push(...fresh);
  }

  found.sort((a, b) => b.lastmod.getTime() - a.lastmod.getTime());
  return found.slice(0, limit).map((entry) => ({
    url: entry.loc,
    lastmod: entry.lastmod,
    title: null,
    topicHint: null,
  }));
}
