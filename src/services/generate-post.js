import * as openrouter from '../lib/openrouter.js';
import { cleanPostText, validatePost } from '../lib/text-clean.js';
import { projectDisplayName } from '../lib/topic.js';
import * as prompts from '../repo/prompts.js';
import * as posts from '../repo/posts.js';
import * as settings from '../repo/settings.js';
import { captureError } from './capture-error.js';
import { log, errFields } from '../logger.js';
import { getRequestId } from '../context.js';

const logger = log('генерация');

/**
 * Схема ответа модели. В коде живёт только каркас — сам промт целиком в БД и правится
 * клиентом в панели. Формат поста (заголовок отдельно от тела) нужен потому, что
 * в postmypost заголовок отдельным полем не идёт, но нам он нужен для панели и обложки.
 */
const POST_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Короткий цепляющий заголовок поста' },
    body: { type: 'string', description: 'Полный текст поста для стены ВК' },
  },
  required: ['title', 'body'],
  additionalProperties: false,
};

/** Сколько исходного текста отдаём модели: больше 12 тысяч символов смысла не добавляет. */
const MAX_SOURCE_CHARS = 12_000;

/**
 * Пользовательская часть запроса. Системная часть — промт клиента из БД, она стабильна
 * и идёт первой (порядок «стабильное начало → переменная часть в конце» — на случай,
 * когда провайдеры включат кеш промта).
 */
function buildUserMessage(article) {
  // Название чистим: при обнаружении через sitemap тема равна slug'у адреса
  // («xrp-turbo-io-razoblachenie»), и в промт уходил жанровый хвост. Модель начинала
  // выкручиваться и склоняла «разоблачение» как часть имени проекта.
  const project = projectDisplayName(article.topic_name)
    || article.title
    || article.topic_key;
  const lines = [`Проект: ${project}`];
  if (article.url) lines.push(`Источник: ${article.url}`);

  if (article.content && article.content.trim().length > 200) {
    lines.push('', 'Материал для рерайта (не копировать дословно):', '',
      article.content.slice(0, MAX_SOURCE_CHARS));
  } else {
    // Режим «только тема»: у all-comment и scama.net текста нет, статью пишет модель сама.
    lines.push(
      '',
      'Готового материала нет — есть только название проекта и то, что на него поступают ' +
        'жалобы. Напиши обзор-отзыв сам, опираясь на типичные схемы таких проектов. ' +
        'Не выдумывай конкретных сумм, дат и имён, которых не знаешь.',
    );
    if (article.title) lines.push('', `Известно о проекте: ${article.title}`);
  }

  return lines.join('\n');
}

/**
 * Генерация поста по материалу.
 *
 * Повторы нужны не из-за сети (это забота http-client), а из-за качества: модель
 * регулярно отдаёт текст короче минимума или забывает рекламный блок. Валидация
 * возвращает список нарушений, и они передаются модели следующей попыткой —
 * это работает заметно лучше, чем просто повторить тот же запрос.
 *
 * @returns {Promise<object>} строка из posts
 */
export async function generatePost(article, { interactive = false } = {}) {
  const requestId = getRequestId() ?? 'no-rid';
  const prompt = await prompts.getActive('post_prompt');
  if (!prompt) throw new Error('В БД нет активного промта post_prompt');

  const minChars = await settings.getInt('post_min_chars', 1200);
  const maxChars = await settings.getInt('post_max_chars', 2200);
  const maxAttempts = await settings.getInt('generation_attempts', 3);
  const adLink = await settings.get('ad_link', 'https://proverka-zarabotka.online');
  const temperature = Number(await settings.get('openrouter_temperature', '0.85'));
  const maxTokens = await settings.getInt('openrouter_max_tokens', 1800);
  // flex вдвое дешевле, но может ждать в очереди — для крона это нормально.
  // Когда генерацию дёрнул человек из панели и ждёт ответ, берём priority.
  const serviceTier = interactive ? 'priority' : await settings.get('openrouter_service_tier', 'flex');

  const rules = { minChars, maxChars, adLink, topicName: article.topic_name || article.title };
  const userMessage = buildUserMessage(article);

  let lastProblems = [];
  let lastError;
  let lastResult;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const messages = [
      { role: 'system', content: prompt.body },
      { role: 'user', content: userMessage },
    ];
    if (lastProblems.length > 0) {
      messages.push({
        role: 'user',
        content:
          'Предыдущий вариант не прошёл проверку. Исправь ровно это и верни пост заново:\n— ' +
          lastProblems.join('\n— '),
      });
    }

    try {
      const result = await openrouter.chat({
        messages,
        schema: POST_SCHEMA,
        schemaName: 'vk_post',
        temperature,
        maxTokens,
        serviceTier,
        // липкость к одному эндпоинту: стабильная латентность вместо перескоков
        sessionId: `vkposter-post-${article.source_code ?? 'x'}`,
      });
      lastResult = result;

      const title = cleanPostText(result.data?.title ?? '').split('\n')[0];
      const body = cleanPostText(result.data?.body ?? '');
      const problems = validatePost(body, rules);

      if (problems.length > 0) {
        lastProblems = problems;
        logger.warn(
          { материал: article.id, попытка: attempt, символов: body.length, нарушения: problems },
          `Пост не прошёл проверку (попытка ${attempt}/${maxAttempts}): ${problems.join('; ')}`,
        );
        continue;
      }

      const saved = await posts.create({
        articleId: article.id,
        title: title || article.topic_name || 'Без заголовка',
        body,
        model: result.model,
        provider: result.provider,
        promptVersion: prompt.version,
        tokensIn: result.usage?.prompt_tokens ?? null,
        tokensOut: result.usage?.completion_tokens ?? null,
        costUsd: result.usage?.cost ?? null,
        latencyMs: result.latencyMs,
        attempts: attempt,
        topicKey: article.topic_key,
        requestId,
      });
      await posts.markArticleQueued(article.id);

      logger.info(
        {
          пост: saved.id,
          материал: article.id,
          тема: article.topic_key,
          символов: body.length,
          попыток: attempt,
          модель: result.model,
        },
        `Пост #${saved.id} готов: ${body.length} символов, попыток ${attempt}, модель ${result.model}`,
      );
      return saved;
    } catch (error) {
      lastError = error;
      // 400/401/402/403 повторять бессмысленно — это ключ, кредиты или запрос
      if ([400, 401, 402, 403].includes(error.code)) break;
      logger.warn(
        { материал: article.id, попытка: attempt, ...errFields(error) },
        `Вызов ИИ упал на попытке ${attempt}/${maxAttempts}`,
      );
    }
  }

  const reason = lastError
    ? lastError.message
    : `валидация не прошла за ${maxAttempts} попыток: ${lastProblems.join('; ')}`;
  const failed = await posts.createFailed({
    articleId: article.id,
    title: article.topic_name ?? article.title,
    model: lastResult?.model ?? openrouter.modelChain()[0],
    promptVersion: prompt.version,
    attempts: maxAttempts,
    topicKey: article.topic_key,
    requestId,
    error: reason,
  });
  logger.error({ материал: article.id, пост: failed.id, причина: reason }, `Генерация поста провалилась: ${reason}`);
  // Записываем именно `lastError`, если он был: в нём тело ответа провайдера, а в `reason`
  // только текст. Когда провайдер отвечал нормально, а брак дала валидация, сервиса нет.
  await captureError('генерация текста', lastError ?? new Error(reason), {
    service: lastError ? 'openrouter' : null,
    details: lastError ? undefined : `Валидация не прошла: ${lastProblems.join('; ')}`,
    articleId: article.id,
    postId: failed.id,
  });
  throw new Error(reason);
}

/** Следующий материал в очереди → пост. Используется кнопкой в панели и cron'ом (этап 9). */
export async function generateNext(options = {}) {
  const article = await posts.nextArticleForGeneration();
  if (!article) throw new Error('Нет материалов, готовых к генерации');
  return generatePost(article, options);
}
