import * as firecrawl from '../lib/firecrawl.js';
import * as articles from '../repo/articles.js';
import * as settings from '../repo/settings.js';
import { projectDisplayName } from '../lib/topic.js';
import { captureError } from './capture-error.js';
import { log, errFields } from '../logger.js';

const logger = log('сбор-материала');

/**
 * Сбор материала о проекте поиском в вебе.
 *
 * Зачем: у scama.net и all-comment своих текстов нет — только названия проектов.
 * Без этого шага такая тема уходит в генерацию «как есть», и модель пишет обзор
 * по типичным схемам мошеннических проектов, не зная о конкретном ничего. Выглядит
 * убедительно, проверяемых фактов ноль. Промт клиента честно просит «поискать в сети»,
 * но у модели через OpenRouter интернета нет — искать должны мы.
 *
 * Правила этого файла:
 *
 * 1. **Никогда не роняет генерацию.** Не нашлось, упал firecrawl, кончился лимит —
 *    пишем запись в журнал «Ошибки» и возвращаем null. Пост будет сделан по теме,
 *    как раньше: хуже, но есть.
 * 2. **Расход виден заранее.** Число страниц берётся из настройки, каждый вызов
 *    логируется отдельной строкой (бесплатный лимит firecrawl — 1000 запросов в месяц
 *    на весь проект, и поиск тратит его быстрее, чем извлечение статей).
 * 3. **Собранное сохраняется вместе со ссылками.** Пост, написанный по чужим страницам,
 *    клиент должен иметь возможность проверить — в карточке материала видно, откуда.
 */

/** Сколько символов собранного материала уходит в промт целиком. */
const MAX_TOTAL_CHARS = 12_000;

/** Материал короче этого считаем неудачей поиска: одна навигация без содержания. */
const MIN_USEFUL_CHARS = 400;

/**
 * Нужен ли сбор для этого материала.
 * @param {object} article строка articles
 * @param {string} mode настройка research_mode
 */
export function shouldResearch(article, mode) {
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  // missing: своего текста нет или он символический (заголовок и меню)
  return !article?.content || article.content.trim().length <= 200;
}

/**
 * Собрать материал по теме и сохранить его в статью.
 *
 * @param {object} article строка articles
 * @param {{force?: boolean}} [options] force — искать, даже если режим «выключено»
 * @returns {Promise<{text: string, urls: string[], pages: number}|null>} null — не искали или не нашли
 */
export async function collectMaterial(article, { force = false } = {}) {
  const mode = await settings.get('research_mode', 'missing');
  if (!force && !shouldResearch(article, mode)) return null;
  if (!firecrawl.isConfigured()) {
    logger.warn('FIRECRAWL_API_KEY не задан — поиск материала пропущен');
    return null;
  }

  const project = projectDisplayName(article.topic_name) || article.title || article.topic_key;
  if (!project) return null;

  const limit = await settings.getInt('research_results', 3);
  const perPage = await settings.getInt('research_chars_per_page', 3000);
  const template = await settings.get('research_query', '"{{проект}}" отзывы обман вывод денег');
  const query = template.replaceAll('{{проект}}', project);

  try {
    const found = await firecrawl.search(query, { limit });
    const pages = found
      .map((page) => ({ ...page, text: cleanPage(page.markdown).slice(0, perPage) }))
      .filter((page) => page.text.length >= MIN_USEFUL_CHARS);

    if (pages.length === 0) {
      logger.warn(
        { материал: article.id, запрос: query, найдено: found.length },
        `Поиск по «${project}» не дал пригодного текста — пост будет написан по теме`,
      );
      return null;
    }

    const text = buildMaterial(project, pages).slice(0, MAX_TOTAL_CHARS);
    const urls = pages.map((page) => page.url);
    await articles.saveResearch(article.id, { text, urls });

    logger.info(
      { материал: article.id, проект: project, страниц: pages.length, символов: text.length },
      `Собран материал по «${project}»: ${pages.length} страниц, ${text.length} символов`,
    );
    return { text, urls, pages: pages.length };
  } catch (error) {
    logger.error(
      { материал: article.id, запрос: query, ...errFields(error) },
      `Сбор материала по «${project}» не удался — пост будет написан по теме`,
    );
    await captureError('сбор материала', error, {
      service: 'firecrawl',
      articleId: article.id,
      details: `запрос: ${query}`,
    });
    return null;
  }
}

/**
 * Склейка найденного в один материал. Источник каждого куска подписан: модель должна
 * понимать, что это несколько независимых страниц, а не одна статья — иначе она
 * склеивает противоречащие детали в один «факт».
 */
function buildMaterial(project, pages) {
  const parts = [
    `Найденные в сети материалы о проекте «${project}». Это выдержки с разных сайтов, ` +
      'а не одна статья: используй их как фактуру, противоречия разрешай в пользу ' +
      'осторожной формулировки, ничего не додумывай.',
  ];
  for (const [index, page] of pages.entries()) {
    parts.push(
      '',
      `--- Источник ${index + 1}: ${page.title ?? page.url}`,
      `Адрес: ${page.url}`,
      '',
      page.text,
    );
  }
  return parts.join('\n');
}

/**
 * Чистка страницы поисковой выдачи: навигация, ссылки и картинки в markdown.
 *
 * Оставлять их нельзя по двум причинам: они съедают лимит символов (в шапке сайта
 * ссылок бывает больше, чем текста в статье) и подсовывают модели чужие адреса,
 * которые она потом вставляет в пост.
 */
function cleanPage(markdown) {
  return String(markdown ?? '')
    // картинки целиком
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // ссылки: остаётся только текст
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // голые адреса в тексте
    .replace(/https?:\/\/\S+/g, '')
    // строки-меню: почти пустые после чистки ссылок
    .split('\n')
    .filter((line) => {
      const value = line.trim();
      if (!value) return true;
      return value.replace(/[^\p{L}\p{N}]+/gu, '').length >= 3;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
