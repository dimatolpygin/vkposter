import { withAdvisoryLock } from '../db/pool.js';
import * as posts from '../repo/posts.js';
import * as runs from '../repo/runs.js';
import { buildPlan } from './plan-run.js';
import { generatePost } from './generate-post.js';
import { generateImageForPost } from './generate-image.js';
import { publishPost } from './publish-post.js';
import { getRequestId } from '../context.js';
import { log, errFields } from '../logger.js';

const logger = log('прогон');

/**
 * Прогон: план → текст → обложка → публикация, по слотам.
 *
 * Три свойства, которые здесь важнее скорости:
 *
 * 1. **Один прогон в моменте.** Второй запуск не ждёт в очереди и не работает параллельно,
 *    а отклоняется: два прогона на одних и тех же материалах — это дубли на стене.
 *    Замок — advisory lock в Postgres (Redis в проекте нет), живёт на время соединения,
 *    поэтому упавший контейнер не оставляет вечную блокировку.
 * 2. **План лежит в БД.** Прерванный прогон при следующем запуске продолжается с того
 *    слота, где встал: уже опубликованные слоты помечены `published` и повторно не уходят.
 * 3. **Сбой слота не роняет прогон.** Каждый слот — своя запись с ошибкой; остальные
 *    посты доезжают.
 */

/** Ключ advisory lock прогона. Произвольная константа, но одна на весь проект. */
const RUN_LOCK_KEY = 815_240_801;

/**
 * @param {object} [options]
 * @param {'cron'|'manual'|'backfill'} [options.kind] чем инициирован прогон
 * @param {number[]} [options.groupIds] ограничить группами (ручной прогон)
 * @param {number} [options.limitPerGroup] потолок постов на группу (проверка, демо)
 */
export async function runCycle({ kind = 'manual', groupIds, limitPerGroup } = {}) {
  const { acquired, result } = await withAdvisoryLock(RUN_LOCK_KEY, () =>
    executeCycle({ kind, groupIds, limitPerGroup }),
  );
  if (!acquired) {
    throw new Error(
      'Прогон уже идёт — второй запуск отклонён. Дождитесь окончания текущего прогона.',
    );
  }
  return result;
}

async function executeCycle({ kind, groupIds, limitPerGroup }) {
  const requestId = getRequestId() ?? null;
  const startedAt = Date.now();

  // Продолжение прерванного прогона имеет приоритет над новым планом: сначала доезжает
  // то, что уже распределено по группам и слотам.
  let run = await runs.unfinishedCycle();
  const resumed = Boolean(run);
  let planReason = null;

  if (run) {
    logger.warn(
      { прогон: run.id, начат: run.started_at },
      `Найден незаконченный прогон #${run.id} — продолжаем его, новый план не строим`,
    );
  } else {
    const plan = await buildPlan({ groupIds, limitPerGroup });
    planReason = plan.reason;
    if (plan.items.length === 0) {
      throw new Error(plan.reason ?? 'Планировать нечего');
    }
    const runId = await runs.startRun({
      requestId,
      kind,
      meta: {
        слотов: plan.items.length,
        групп: plan.groups.length,
        окно: plan.items.length
          ? `${formatTime(plan.items[0].postAt)}-${formatTime(plan.items.at(-1).postAt)}`
          : null,
      },
    });
    await runs.addItems(runId, plan.items);
    run = { id: runId };
    logger.info(
      { прогон: runId, слотов: plan.items.length },
      `Прогон #${runId} начат: ${plan.items.length} слотов`,
    );
  }

  const items = (await runs.listItems(run.id)).filter((item) =>
    ['planned', 'generated'].includes(item.status),
  );

  let generated = 0;
  let published = 0;
  const failures = [];

  for (const item of items) {
    try {
      let post = item.post_id ? await posts.findById(Number(item.post_id)) : null;

      if (!post) {
        const article = await posts.findArticleForGeneration(Number(item.article_id));
        if (!article) throw new Error(`Материал #${item.article_id} исчез из базы`);
        post = await generatePost(article);
        generated += 1;
        await runs.setItemPost(item.id, post.id);
      }

      if (!post.image_url) {
        post = await generateImageForPost(post);
      }

      // postAt берётся из плана, а не «сейчас + N минут»: именно план разносит публикации
      // по слотам, и продолжение прерванного прогона должно попадать в свои же времена.
      await publishPost(post, {
        groupIds: [Number(item.group_id)],
        postAt: new Date(item.post_at),
      });
      await runs.setItemStatus(item.id, 'published');
      published += 1;
    } catch (error) {
      await runs.setItemStatus(item.id, 'failed', error.message);
      failures.push({ slot: item.slot_no, group: item.group_name, error });
      logger.error(
        { прогон: run.id, слот: item.slot_no, группа: item.group_name, ...errFields(error) },
        `Слот ${item.slot_no} («${item.group_name}») не отработал: ${error.message}`,
      );
    }
  }

  const status = published === 0 && failures.length > 0 ? 'failed' : 'done';
  await runs.finishRun(run.id, {
    status,
    found: items.length,
    generated,
    published,
    error: failures.length
      ? failures.map((item) => `слот ${item.slot}: ${item.error.message}`).join('; ')
      : null,
  });

  const ms = Date.now() - startedAt;
  logger.info(
    { прогон: run.id, слотов: items.length, сгенерировано: generated, опубликовано: published,
      сбоев: failures.length, продолжение: resumed, ms },
    `Прогон #${run.id} завершён: опубликовано ${published} из ${items.length}` +
      (generated ? `, сгенерировано ${generated}` : '') +
      (failures.length ? `, сбоев ${failures.length}` : '') +
      `, ${Math.round(ms / 1000)} c`,
  );

  return {
    runId: run.id,
    resumed,
    planned: items.length,
    generated,
    published,
    failed: failures.length,
    failures,
    planReason,
    ms,
  };
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
