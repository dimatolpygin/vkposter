import * as runs from '../repo/runs.js';
import * as settings from '../repo/settings.js';
import { nextRunAt, isRunDue, scheduleText } from '../lib/schedule.js';
import { startCycleInBackground, runningSince } from './run-cycle.js';
import { captureError } from './capture-error.js';
import { runWithContext, newRequestId } from '../context.js';
import { log, errFields } from '../logger.js';

const logger = log('планировщик');

/**
 * Автозапуск прогона по расписанию.
 *
 * Почему тикер раз в минуту, а не `node-cron` с cron-выражением:
 *
 * 1. **Расписание живёт в БД и правится в панели.** Cron-задачу пришлось бы пересоздавать
 *    на каждое изменение настройки, а «каждые N часов от последнего прогона» в cron-выражение
 *    не переводится вообще — там нет понятия «от последнего запуска».
 * 2. **Время следующего запуска считает та же функция, что показывает панель** (`nextRunAt`).
 *    Одна формула на показ и на исполнение — расхождение между «панель обещала 14:00»
 *    и «запустилось в 15:00» просто невозможно.
 * 3. **Перезапуск контейнера ничего не теряет**: точка отсчёта — `runs.started_at` из БД,
 *    а не таймер в памяти.
 *
 * Минута — достаточная точность: посты и так раскладываются по слотам с джиттером.
 */

const TICK_MS = 60_000;
/** Первый тик — не сразу: даём приложению доподняться и не стартуем прогон в момент деплоя. */
const FIRST_TICK_MS = 90_000;

let timer = null;
/** Последняя неудачная попытка автозапуска: чтобы не долбить провалом каждую минуту. */
let lastFailureAt = null;
let lastFailureReason = null;

export function startScheduler() {
  if (timer) return;
  timer = setInterval(() => { void tick(); }, TICK_MS);
  timer.unref();
  setTimeout(() => { void tick(); }, FIRST_TICK_MS).unref();
  logger.info(
    { интервал_с: TICK_MS / 1000 },
    'Планировщик поднят: проверяет расписание раз в минуту',
  );
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Что показывать в панели: включён ли автозапуск, когда следующий, была ли осечка. */
export async function schedulerState(map = null) {
  const settingsMap = map ?? (await settings.getMap());
  const enabled = settingsMap.schedule_enabled === 'on';
  const last = await runs.lastCycle();
  const anchor = last?.started_at ?? settingsMap.schedule_enabled_at ?? null;
  return {
    enabled,
    text: scheduleText(settingsMap),
    nextAt: nextRunAt(settingsMap, anchor),
    due: isRunDue(settingsMap, anchor),
    lastCycle: last,
    running: runningSince(),
    failureAt: lastFailureAt,
    failureReason: lastFailureReason,
  };
}

async function tick() {
  try {
    const map = await settings.getMap();
    if (map.schedule_enabled !== 'on') return;
    if (runningSince()) return;

    // Осечка (например, кончились кредиты) не должна превращаться в минутный цикл
    // из одинаковых ошибок в логе.
    const retryMs = Math.max(1, Number.parseInt(map.scheduler_retry_minutes ?? '15', 10) || 15) * 60_000;
    if (lastFailureAt && Date.now() - lastFailureAt < retryMs) return;

    // Якорь: последний прогон, а если прогонов не было — момент включения автозапуска.
    // Без второго варианта режим «каждые N часов» на пустой базе не стартовал бы никогда.
    const last = await runs.lastCycle();
    const anchor = last?.started_at ?? map.schedule_enabled_at ?? null;
    if (!isRunDue(map, anchor)) return;

    await runWithContext({ requestId: newRequestId('cron'), source: 'планировщик' }, async () => {
      const { started, reason } = startCycleInBackground({ kind: 'cron' });
      if (!started) {
        lastFailureAt = Date.now();
        lastFailureReason = reason;
        logger.warn(
          { причина: reason, расписание: scheduleText(map) },
          `Автозапуск не состоялся: ${reason}`,
        );
        return;
      }
      lastFailureAt = null;
      lastFailureReason = null;
      logger.info(
        { расписание: scheduleText(map), было_в: last?.started_at ?? null },
        `Автозапуск по расписанию (${scheduleText(map)}) — прогон стартовал`,
      );
    });
  } catch (error) {
    lastFailureAt = Date.now();
    lastFailureReason = error.message;
    await captureError('планировщик', error).catch(() => {});
    logger.error(errFields(error), `Тик планировщика упал: ${error.message}`);
  }
}
