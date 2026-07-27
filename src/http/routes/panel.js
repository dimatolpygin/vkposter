import { Router } from 'express';
import { requireAuth } from '../../auth/middleware.js';
import { page, esc } from '../views/layout.js';
import { query } from '../../db/pool.js';
import * as sources from '../../repo/sources.js';
import * as settings from '../../repo/settings.js';
import * as articles from '../../repo/articles.js';
import * as prompts from '../../repo/prompts.js';
import * as posts from '../../repo/posts.js';
import * as groups from '../../repo/groups.js';
import * as publications from '../../repo/publications.js';
import * as runs from '../../repo/runs.js';
import { checkSource } from '../../services/check-source.js';
import { buildPlan } from '../../services/plan-run.js';
import { runCycle } from '../../services/run-cycle.js';
import { nextRunAt, scheduleText } from '../../lib/schedule.js';
import { generatePost } from '../../services/generate-post.js';
import { generateImageForPost } from '../../services/generate-image.js';
import { publishPost } from '../../services/publish-post.js';
import { syncGroups } from '../../services/sync-groups.js';
import * as kie from '../../lib/kie.js';
import * as pmp from '../../lib/postmypost.js';
import { log, errFields } from '../../logger.js';

const logger = log('панель');

/** Заглушка раздела, который наполняется на своём этапе. */
function soon(stage, what) {
  return `<div class="card">
      <span class="tag soon">этап ${stage}</span>
      <p style="margin:10px 0 0">${what}</p>
    </div>`;
}

export function panelRouter() {
  const router = Router();
  router.use(requireAuth());

  // ── Обзор ────────────────────────────────────────────────────────────────
  router.get('/', async (req, res, next) => {
    try {
      const { rows } = await query(`
        SELECT
          (SELECT count(*) FROM sources WHERE is_active)   AS sources_active,
          (SELECT count(*) FROM sources)                   AS sources_total,
          (SELECT count(*) FROM groups
            WHERE is_active AND deleted_at IS NULL)        AS groups_active,
          (SELECT count(*) FROM articles)                  AS articles,
          (SELECT count(DISTINCT topic_key) FROM articles
            WHERE topic_key IS NOT NULL AND status <> 'duplicate') AS topics,
          (SELECT count(*) FROM posts)                     AS posts,
          (SELECT count(*) FROM publications)              AS publications,
          (SELECT count(*) FROM runs)                      AS runs
      `);
      const s = rows[0];
      const map = await settings.getMap();
      const lastCycle = await runs.lastCycle();
      const next = nextRunAt(map, lastCycle?.started_at ?? null);

      const body = `
        <div class="grid">
          ${stat(`${s.sources_active} из ${s.sources_total}`, 'Источников активно')}
          ${stat(s.groups_active, 'Групп ВК активно')}
          ${stat(s.articles, 'Материалов найдено')}
          ${stat(s.topics, 'Уникальных тем')}
          ${stat(s.posts, 'Постов сгенерировано')}
          ${stat(s.publications, 'Публикаций')}
          ${stat(s.runs, 'Прогонов')}
        </div>
        <h2>Текущая конфигурация</h2>
        <div class="card">
          <table>
            <tr><th>Окно свежести</th><td>${esc(map.freshness_window_days)} дней</td></tr>
            <tr><th>Постов в день на группу</th><td>${esc(map.default_posts_per_day)}</td></tr>
            <tr><th>Расписание</th><td>${esc(scheduleText(map))}</td></tr>
            <tr><th>Следующий запуск</th><td>${esc(formatDate(next))}
              <span class="hint">автозапуск по расписанию включается на этапе 9;
                сейчас это время, на которое встанет прогон</span></td></tr>
            <tr><th>Окно публикаций</th><td>${esc(map.posting_window_start)}-${
              esc(map.posting_window_end)} МСК, разброс до ${esc(map.slot_jitter_minutes)} мин</td></tr>
            <tr><th>Режим публикации</th><td>${publishModeTag(map.publish_mode)}</td></tr>
            <tr><th>Длина поста</th><td>${esc(map.post_min_chars)}-${esc(map.post_max_chars)} символов</td></tr>
          </table>
        </div>
        <h2>Прогон</h2>
        ${await runCard(lastCycle)}`;

      res.type('html').send(
        page({
          title: 'Обзор',
          active: '/',
          user: req.user,
          heading: 'Обзор',
          sub: 'Сводка по системе. Разделы наполняются по мере прохождения этапов.',
          message: buildSourceMessage(req.query),
          body,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  // ── Источники ────────────────────────────────────────────────────────────
  router.get('/sources', async (req, res, next) => {
    try {
      const list = await sources.listAll();
      const stats = await articles.statsBySource();
      const recent = await articles.listRecent(30);
      const rejected = await articles.listRejected(20);

      const rows = list
        .map((item) => {
          const st = stats.get(item.id) ?? {
            total: 0, with_text: 0, failed: 0, topics: 0, topic_duplicates: 0, skipped: 0,
          };
          return `<tr>
            <td><strong>${esc(item.title)}</strong><br><span class="hint">${esc(item.base_url)}</span></td>
            <td>${esc(discoveryText(item))}</td>
            <td>${esc(item.content_mode === 'text' ? 'рерайт статьи' : 'только тема')}</td>
            <td>${esc(fetchViaText(item.fetch_via))}</td>
            <td>${st.total}${st.with_text ? ` <span class="hint">(с текстом ${st.with_text})</span>` : ''}${
              st.failed ? ` <span class="tag soon">сбоев ${st.failed}</span>` : ''
            }</td>
            <td>${st.topics ?? 0}${
              st.topic_duplicates ? ` <span class="hint">дублей ${st.topic_duplicates}</span>` : ''
            }${st.skipped ? ` <span class="hint">служебных ${st.skipped}</span>` : ''}</td>
            <td class="hint">${esc(formatDate(item.last_checked_at) || 'ни разу')}</td>
            <td>${item.is_active ? '<span class="tag on">включён</span>' : '<span class="tag off">выключен</span>'}</td>
            <td style="white-space:nowrap">
              <form class="inline" method="post" action="/sources/${item.id}/check">
                <button class="small" type="submit"${item.is_active ? '' : ' disabled'}>Проверить</button>
              </form>
              <form class="inline" method="post" action="/sources/${item.id}/toggle">
                <button class="ghost small" type="submit">${item.is_active ? 'Выключить' : 'Включить'}</button>
              </form>
            </td>
          </tr>
          <tr><td colspan="9" class="hint" style="padding-top:0">${esc(item.notes ?? '')}</td></tr>`;
        })
        .join('\n');

      const recentRows = recent.length
        ? recent
            .map(
              (item) => `<tr>
                <td class="hint">${esc(item.source_code)}</td>
                <td>${esc(item.title ?? '(заголовок появится при извлечении)')}
                    <br><a href="${esc(item.url)}" target="_blank" rel="noopener"
                          class="hint">${esc(item.url)}</a></td>
                <td>${topicCell(item)}</td>
                <td class="hint">${esc(formatDate(item.lastmod))}</td>
                <td>${statusTag(item)}</td>
              </tr>`,
            )
            .join('\n')
        : '<tr><td colspan="5" class="empty">Пока ничего не найдено. Нажмите «Проверить» у любого источника.</td></tr>';

      const rejectedRows = rejected.length
        ? rejected
            .map(
              (item) => `<tr>
                <td class="hint">${esc(item.source_code)}</td>
                <td><a href="${esc(item.url)}" target="_blank" rel="noopener"
                       class="hint">${esc(item.url)}</a></td>
                <td>${topicCell(item)}</td>
                <td>${item.status === 'duplicate'
                    ? '<span class="tag off">дубль темы</span>'
                    : '<span class="tag off">пропущен</span>'}
                    <span class="hint">${esc(item.skip_reason ?? '')}</span></td>
              </tr>`,
            )
            .join('\n')
        : '<tr><td colspan="4" class="empty">Отклонённых материалов нет.</td></tr>';

      const body = `
        <div class="card">
          <table>
            <thead><tr>
              <th>Источник</th><th>Откуда берём</th><th>Режим</th><th>Доступ</th>
              <th>Материалов</th><th>Тем</th><th>Проверен</th><th>Статус</th><th></th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
            <form method="post" action="/sources/check-all">
              <button type="submit">Проверить все включённые</button>
            </form>
            <form method="post" action="/sources/topics/recompute">
              <button class="ghost" type="submit">Пересчитать темы</button>
            </form>
          </div>
          <p class="hint" style="margin:10px 0 0">
            «Тем» — сколько разных проектов набралось после дедупа. Пересчёт нужен после
            правки правил нормализации названий: заново размечает уже найденные материалы.
          </p>
        </div>

        <h2>Последние найденные материалы</h2>
        <div class="card">
          <table>
            <thead><tr><th>Источник</th><th>Материал</th><th>Тема</th><th>Дата</th><th>Состояние</th></tr></thead>
            <tbody>${recentRows}</tbody>
          </table>
        </div>

        <h2>Отклонённые материалы</h2>
        <div class="card">
          <p class="hint" style="margin:0 0 10px">
            Дубли темы и служебные страницы. Дубль обычно старше «победителя», поэтому
            в списке выше он не виден — причина отклонения показана здесь.
          </p>
          <table>
            <thead><tr><th>Источник</th><th>Материал</th><th>Тема</th><th>Причина отклонения</th></tr></thead>
            <tbody>${rejectedRows}</tbody>
          </table>
        </div>`;

      res.type('html').send(
        page({
          title: 'Источники',
          active: '/sources',
          user: req.user,
          heading: 'Источники',
          sub: 'Раздел для исполнителя: новые сайты подключаются с индивидуальной настройкой парсинга.',
          message: buildSourceMessage(req.query),
          body,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  // Проверка одного источника
  router.post('/sources/:id/check', async (req, res, next) => {
    try {
      const source = await sources.findById(Number.parseInt(req.params.id, 10));
      if (!source) return res.status(404).json({ error: 'Источник не найден' });

      const result = await checkSource(source);
      const summary =
        `${source.code}: найдено ${result.discovered}, новых ${result.added}, ` +
        `дублей URL ${result.duplicates}, дублей темы ${result.topicDuplicates}` +
        (result.listings ? `, служебных страниц ${result.listings}` : '') +
        `, текстов ${result.extracted}` +
        (result.extractFailed ? `, сбоев ${result.extractFailed}` : '') +
        `, ${Math.round(result.ms / 1000)} c`;
      res.redirect(`/sources?ok=${encodeURIComponent(summary)}`);
    } catch (error) {
      logger.error(errFields(error), 'Проверка источника из панели упала');
      res.redirect(`/sources?err=${encodeURIComponent(error.message)}`);
      return undefined;
    }
  });

  // Проверка всех включённых источников
  router.post('/sources/check-all', async (req, res) => {
    const active = await sources.listActive();
    const parts = [];
    for (const source of active) {
      try {
        const result = await checkSource(source);
        parts.push(`${source.code}: +${result.added} (текстов ${result.extracted})`);
      } catch (error) {
        parts.push(`${source.code}: ошибка — ${error.message}`);
        logger.error({ источник: source.code, ...errFields(error) }, 'Проверка источника упала');
      }
    }
    res.redirect(`/sources?ok=${encodeURIComponent(parts.join('; '))}`);
  });

  // Пересчёт тем у уже найденных материалов (после правки правил нормализации)
  router.post('/sources/topics/recompute', async (req, res) => {
    try {
      const stats = await articles.recomputeTopics();
      const summary =
        `Пересчитано ${stats.processed}: тем ${stats.keyed}, дублей темы ${stats.duplicates}, ` +
        `служебных страниц ${stats.listings}` +
        (stats.unkeyed ? `, без темы ${stats.unkeyed}` : '');
      logger.info({ ...stats, кто: req.user.login }, 'Темы пересчитаны из панели');
      res.redirect(`/sources?ok=${encodeURIComponent(summary)}`);
    } catch (error) {
      logger.error(errFields(error), 'Пересчёт тем упал');
      res.redirect(`/sources?err=${encodeURIComponent(error.message)}`);
    }
  });

  router.post('/sources/:id/toggle', async (req, res, next) => {
    try {
      const source = await sources.findById(Number.parseInt(req.params.id, 10));
      if (!source) return res.status(404).json({ error: 'Источник не найден' });
      await sources.setActive(source.id, !source.is_active);
      logger.info(
        { источник: source.code, включён: !source.is_active, кто: req.user.login },
        `Источник ${source.code} ${!source.is_active ? 'включён' : 'выключен'}`,
      );
      res.redirect('/sources?ok=1');
    } catch (error) {
      next(error);
    }
  });

  // ── Настройки ────────────────────────────────────────────────────────────
  router.get('/settings', async (req, res, next) => {
    try {
      const list = await settings.getAll();
      const rows = list
        .filter((row) => !row.key.endsWith('_prompt'))
        .map(
          (row) => `<tr>
            <td><code>${esc(row.key)}</code><br><span class="hint">${esc(row.title ?? '')}</span></td>
            <td>${esc(row.value)}</td>
            <td class="hint">${esc(formatDate(row.updated_at))}</td>
          </tr>`,
        )
        .join('\n');

      const mode = await settings.get('publish_mode', 'draft');
      const map = await settings.getMap();
      const next = nextRunAt(map, (await runs.lastCycle())?.started_at ?? null);
      const body = `
        <div class="card">
          <h2 style="margin-top:0">Расписание прогонов</h2>
          <p class="hint" style="margin:0 0 12px">
            Сейчас: ${esc(scheduleText(map))}. Следующий запуск ${esc(formatDate(next))}.
            Автозапуск включается на этапе 9, но время считается уже по этим настройкам.
          </p>
          <form method="post" action="/settings/schedule">
            <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end">
              <label>режим<br>
                <select name="schedule_mode">
                  <option value="daily"${map.schedule_mode === 'daily' ? ' selected' : ''}>раз в день</option>
                  <option value="interval"${map.schedule_mode === 'interval' ? ' selected' : ''}>каждые N часов</option>
                </select></label>
              <label>каждые N часов<br>
                <input type="number" name="schedule_interval_hours" min="1" max="168"
                       value="${esc(map.schedule_interval_hours)}" style="width:80px"></label>
              <label>время ежедневного запуска<br>
                <input type="text" name="schedule_daily_at" value="${esc(map.schedule_daily_at)}"
                       placeholder="10:00" style="width:80px"></label>
              <button type="submit">Сохранить расписание</button>
            </div>
          </form>
        </div>
        <div class="card">
          <h2 style="margin-top:0">Окно публикаций и объём</h2>
          <p class="hint" style="margin:0 0 12px">
            Публикации разносятся по слотам внутри окна со случайным сдвигом: залп в одну
            минуту выглядит как бот. «Постов в день» здесь - значение для новых групп;
            у каждой группы своё в разделе «Группы».
          </p>
          <form method="post" action="/settings/posting">
            <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end">
              <label>окно с<br>
                <input type="text" name="posting_window_start" value="${esc(map.posting_window_start)}"
                       style="width:80px"></label>
              <label>по<br>
                <input type="text" name="posting_window_end" value="${esc(map.posting_window_end)}"
                       style="width:80px"></label>
              <label>разброс, мин<br>
                <input type="number" name="slot_jitter_minutes" min="0" max="120"
                       value="${esc(map.slot_jitter_minutes)}" style="width:80px"></label>
              <label>окно свежести, дней<br>
                <input type="number" name="freshness_window_days" min="1" max="3650"
                       value="${esc(map.freshness_window_days)}" style="width:80px"></label>
              <label>постов в день<br>
                <input type="number" name="default_posts_per_day" min="0" max="100"
                       value="${esc(map.default_posts_per_day)}" style="width:80px"></label>
              <button type="submit">Сохранить</button>
            </div>
          </form>
        </div>
        <div class="card">
          <h2 style="margin-top:0">Режим публикации</h2>
          <p style="margin:0 0 10px">Сейчас: ${publishModeTag(mode)}</p>
          <p class="hint" style="margin:0 0 12px">
            В режиме «черновики» посты создаются в postmypost со статусом 4 и на стену
            не уходят — их видно только в интерфейсе postmypost. «Реальная публикация»
            ставит статус 5, и пост появляется в группе ВК в назначенное время.
          </p>
          <form method="post" action="/settings/publish-mode">
            <input type="hidden" name="mode" value="${mode === 'live' ? 'draft' : 'live'}">
            <button ${mode === 'live' ? 'class="ghost"' : ''} type="submit">${
              mode === 'live' ? 'Вернуть режим черновиков' : 'Включить реальную публикацию'
            }</button>
          </form>
        </div>
        <div class="card">
          <table>
            <thead><tr><th>Ключ</th><th>Значение</th><th>Изменено</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <p class="hint">
          Остальные ключи правятся по месту: промты - в разделе «Промты», объём по группам -
          в разделе «Группы». Служебные значения (таймауты и интервалы опроса провайдеров)
          меняются миграцией.
        </p>`;

      res.type('html').send(
        page({
          title: 'Настройки',
          active: '/settings',
          user: req.user,
          heading: 'Настройки',
          sub: 'Значения засеяны из брифа. Правка остальных ключей через панель появится на этапе 8.',
          message: buildSourceMessage(req.query),
          body,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  // Переключатель режима публикации. Отдельным роутом, а не общей формой настроек:
  // это единственное значение, ошибка в котором видна подписчикам группы.
  router.post('/settings/publish-mode', async (req, res) => {
    try {
      const mode = req.body.mode === 'live' ? 'live' : 'draft';
      await settings.set('publish_mode', mode);
      logger.warn(
        { режим: mode, кто: req.user.login },
        `Режим публикации переключён на «${mode === 'live' ? 'реальная публикация' : 'черновики'}»`,
      );
      res.redirect(
        `/settings?ok=${encodeURIComponent(
          mode === 'live'
            ? 'Включена реальная публикация — посты будут уходить на стену группы'
            : 'Включён режим черновиков',
        )}`,
      );
    } catch (error) {
      logger.error(errFields(error), 'Переключение режима публикации упало');
      res.redirect(`/settings?err=${encodeURIComponent(error.message)}`);
    }
  });

  router.post('/settings/schedule', async (req, res) => {
    try {
      const mode = req.body.schedule_mode === 'interval' ? 'interval' : 'daily';
      const hours = requireInt(req.body.schedule_interval_hours, 1, 168, 'Интервал запуска, часов');
      const at = requireHhMm(req.body.schedule_daily_at, 'Время ежедневного запуска');
      await settings.set('schedule_mode', mode);
      await settings.set('schedule_interval_hours', String(hours));
      await settings.set('schedule_daily_at', at);
      const map = await settings.getMap();
      const next = nextRunAt(map, (await runs.lastCycle())?.started_at ?? null);
      logger.info(
        { режим: mode, интервал: hours, время: at, кто: req.user.login },
        `Расписание изменено: ${scheduleText(map)}, следующий запуск ${formatDate(next)}`,
      );
      res.redirect(
        `/settings?ok=${encodeURIComponent(
          `Расписание: ${scheduleText(map)}. Следующий запуск ${formatDate(next)}`,
        )}`,
      );
    } catch (error) {
      logger.error(errFields(error), 'Сохранение расписания упало');
      res.redirect(`/settings?err=${encodeURIComponent(error.message)}`);
    }
  });

  router.post('/settings/posting', async (req, res) => {
    try {
      const start = requireHhMm(req.body.posting_window_start, 'Начало окна публикаций');
      const end = requireHhMm(req.body.posting_window_end, 'Конец окна публикаций');
      if (start >= end) throw new Error('Начало окна публикаций должно быть раньше конца');
      const jitter = requireInt(req.body.slot_jitter_minutes, 0, 120, 'Разброс времени, минут');
      const freshness = requireInt(req.body.freshness_window_days, 1, 3650, 'Окно свежести, дней');
      const perDay = requireInt(req.body.default_posts_per_day, 0, 100, 'Постов в день');
      await settings.set('posting_window_start', start);
      await settings.set('posting_window_end', end);
      await settings.set('slot_jitter_minutes', String(jitter));
      await settings.set('freshness_window_days', String(freshness));
      await settings.set('default_posts_per_day', String(perDay));
      logger.info(
        { окно: `${start}-${end}`, разброс: jitter, свежесть: freshness, постов_в_день: perDay,
          кто: req.user.login },
        `Настройки постинга изменены: окно ${start}-${end}, разброс ${jitter} мин`,
      );
      res.redirect(
        `/settings?ok=${encodeURIComponent(`Окно публикаций ${start}-${end}, разброс ${jitter} мин`)}`,
      );
    } catch (error) {
      logger.error(errFields(error), 'Сохранение настроек постинга упало');
      res.redirect(`/settings?err=${encodeURIComponent(error.message)}`);
    }
  });

  // ── Промты ───────────────────────────────────────────────────────────────
  router.get('/prompts', async (req, res, next) => {
    try {
      const body = `
        ${await promptCard('post_prompt', 'Промт текста поста', 20,
          'Системная часть запроса к модели. Правка создаёт новую версию и применяется ' +
          'к следующей генерации сразу, без перезапуска контейнера.')}
        ${await promptCard('image_prompt', 'Промт обложки', 8,
          'Используется при генерации картинки (этап 5).')}`;

      res.type('html').send(
        page({
          title: 'Промты',
          active: '/prompts',
          user: req.user,
          heading: 'Промты',
          sub: 'Промт клиента живёт в базе, а не в коде: правится в панели без пересборки.',
          message: buildSourceMessage(req.query),
          body,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post('/prompts/:key', async (req, res) => {
    const key = req.params.key;
    try {
      const text = String(req.body.body ?? '').trim();
      if (!['post_prompt', 'image_prompt'].includes(key)) throw new Error('Неизвестный промт');
      if (text.length < 50) throw new Error('Промт слишком короткий — похоже на случайное сохранение');
      const version = await prompts.saveVersion(key, text, {
        note: String(req.body.note ?? '').trim() || null,
        createdBy: req.user.login,
      });
      res.redirect(`/prompts?ok=${encodeURIComponent(`${key}: сохранена версия ${version}`)}`);
    } catch (error) {
      logger.error({ промт: key, ...errFields(error) }, 'Сохранение промта упало');
      res.redirect(`/prompts?err=${encodeURIComponent(error.message)}`);
    }
  });

  router.post('/prompts/:key/activate/:version', async (req, res) => {
    const { key, version } = req.params;
    try {
      await prompts.activateVersion(key, Number.parseInt(version, 10), { by: req.user.login });
      res.redirect(`/prompts?ok=${encodeURIComponent(`${key}: активна версия ${version}`)}`);
    } catch (error) {
      logger.error({ промт: key, версия: version, ...errFields(error) }, 'Откат промта упал');
      res.redirect(`/prompts?err=${encodeURIComponent(error.message)}`);
    }
  });

  // ── Посты ────────────────────────────────────────────────────────────────
  router.get('/posts', async (req, res, next) => {
    try {
      const list = await posts.listRecent(30);
      const totals = await posts.countAll();
      const nextArticle = await posts.nextArticleForGeneration();
      const nextWithoutImage = await posts.nextWithoutImage();
      const nextToPublish = await posts.nextForPublishing();

      const rows = list.length
        ? list
            .map(
              (item) => `<tr>
                <td>#${item.id}</td>
                <td>${thumbCell(item)}</td>
                <td><a href="/posts/${item.id}">${esc(item.title)}</a>
                    <br><span class="hint">${esc(item.source_code ?? '')} · тема
                    <code>${esc(item.topic_key ?? '—')}</code></span></td>
                <td>${item.char_count}</td>
                <td class="hint">${esc(item.model ?? '')}${
                  item.attempts > 1 ? `<br>попыток ${item.attempts}` : ''
                }</td>
                <td class="hint">${item.latency_ms ? `${Math.round(item.latency_ms / 100) / 10} c` : ''}${
                  item.cost_usd ? `<br>$${Number(item.cost_usd).toFixed(5)}` : ''
                }</td>
                <td>${item.status === 'failed'
                    ? `<span class="tag off">сбой</span> <span class="hint">${esc(item.error ?? '')}</span>`
                    : '<span class="tag on">готов</span>'}</td>
                <td class="hint">${esc(formatDate(item.created_at))}</td>
              </tr>`,
            )
            .join('\n')
        : '<tr><td colspan="8" class="empty">Постов пока нет.</td></tr>';

      const body = `
        <div class="grid">
          ${stat(totals.total, 'Постов всего')}
          ${stat(totals.failed, 'Сбоев генерации')}
          ${stat(`$${Number(totals.cost).toFixed(4)}`, 'Израсходовано на текст')}
          ${stat(`${totals.with_image} из ${totals.total}`, 'С обложкой')}
          ${stat(totals.published, 'Опубликовано')}
          ${stat(await creditsText(), 'Кредитов на kie.ai')}
        </div>
        ${nextWithoutImage
          ? `<div class="card">
               <h2 style="margin-top:0">Пост без обложки</h2>
               <p style="margin:0 0 4px"><strong>#${nextWithoutImage.id}
                 ${esc(nextWithoutImage.title)}</strong></p>
               <p class="hint" style="margin:0 0 12px">
                 Обложка делается через kie.ai и складывается в наш /media —
                 временную ссылку провайдера в postmypost отдавать нельзя, она истекает.</p>
               <form method="post" action="/posts/${nextWithoutImage.id}/image">
                 <button type="submit">Сгенерировать обложку</button>
               </form>
               ${nextWithoutImage.image_error
                 ? `<p class="hint" style="margin:10px 0 0">Прошлая попытка:
                    ${esc(nextWithoutImage.image_error)}</p>`
                 : ''}
             </div>`
          : ''}
        ${nextToPublish
          ? `<div class="card">
               <h2 style="margin-top:0">Готов к публикации</h2>
               <p style="margin:0 0 4px"><strong>#${nextToPublish.id}
                 ${esc(nextToPublish.title)}</strong></p>
               ${await publishForm(nextToPublish)}
             </div>`
          : ''}
        <div class="card">
          <h2 style="margin-top:0">Следующий материал в очереди</h2>
          ${nextArticle
            ? `<p style="margin:0 0 4px"><strong>${esc(nextArticle.topic_name ?? nextArticle.title ?? '')}</strong></p>
               <p class="hint" style="margin:0 0 12px">${esc(nextArticle.source_code)} ·
                 ${esc(formatDate(nextArticle.published_at))} ·
                 ${nextArticle.content ? `текст ${nextArticle.content.length} симв.` : 'только тема'} ·
                 <a href="${esc(nextArticle.url)}" target="_blank" rel="noopener">${esc(nextArticle.url)}</a></p>
               <form method="post" action="/posts/generate">
                 <button type="submit">Сгенерировать пост</button>
               </form>`
            : '<p class="hint" style="margin:0">Материалов, готовых к генерации, нет. ' +
              'Проверьте источники в разделе «Источники».</p>'}
          <p class="hint" style="margin:12px 0 0">
            Очередь идёт от свежих к старым. Темы, по которым пост уже есть, пропускаются.
          </p>
        </div>

        <h2>Сгенерированные посты</h2>
        <div class="card">
          <table>
            <thead><tr>
              <th>ID</th><th>Обложка</th><th>Заголовок</th><th>Символов</th><th>Модель</th>
              <th>Время / цена</th><th>Статус</th><th>Создан</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;

      res.type('html').send(
        page({
          title: 'Посты',
          active: '/posts',
          user: req.user,
          heading: 'Посты',
          sub: 'Текст генерируется по промту из раздела «Промты» и проверяется на требования формата.',
          message: buildSourceMessage(req.query),
          body,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post('/posts/generate', async (req, res) => {
    try {
      const article = req.body.article_id
        ? await posts.findArticleForGeneration(Number.parseInt(req.body.article_id, 10))
        : await posts.nextArticleForGeneration();
      if (!article) throw new Error('Нет материалов, готовых к генерации');
      // interactive: человек ждёт ответ, поэтому тир priority вместо flex
      const post = await generatePost(article, { interactive: true });
      res.redirect(`/posts/${post.id}?ok=${encodeURIComponent(`Пост #${post.id} готов`)}`);
    } catch (error) {
      logger.error(errFields(error), 'Генерация поста из панели упала');
      res.redirect(`/posts?err=${encodeURIComponent(error.message)}`);
    }
  });

  // Обложка поста. Генерация синхронная: человек в панели ждёт результат, а kie.ai
  // отвечает за 30-90 секунд — очередь появится вместе с кроном на этапе 9.
  router.post('/posts/:id/image', async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    try {
      const post = await posts.findById(id);
      if (!post) throw new Error(`Поста #${id} нет`);
      const updated = await generateImageForPost(post);
      res.redirect(
        `/posts/${id}?ok=${encodeURIComponent(
          `Обложка готова: кредитов ${updated.image_credits ?? '?'}, ` +
            `${Math.round((updated.image_latency_ms ?? 0) / 1000)} c`,
        )}`,
      );
    } catch (error) {
      logger.error({ пост: id, ...errFields(error) }, 'Генерация обложки из панели упала');
      res.redirect(`/posts/${id}?err=${encodeURIComponent(error.message)}`);
    }
  });

  // Синхронизация групп ВК из postmypost. Кнопка есть и в разделе «Группы»,
  // и в форме публикации — поле back говорит, куда вернуться.
  router.post('/groups/sync', async (req, res) => {
    const back = typeof req.body.back === 'string' && req.body.back.startsWith('/')
      ? req.body.back
      : '/groups';
    try {
      const result = await syncGroups();
      const summary = `Групп ВК из postmypost: ${result.total} (новых ${result.added}` +
        (result.broken ? `, отвалившихся ${result.broken}` : '') +
        (result.hidden ? `, скрытых ${result.hidden}` : '') + ')';
      res.redirect(`${back}?ok=${encodeURIComponent(summary)}`);
    } catch (error) {
      logger.error(errFields(error), 'Синхронизация групп из панели упала');
      res.redirect(`${back}?err=${encodeURIComponent(error.message)}`);
    }
  });

  // Публикация поста. Синхронная: заливка картинки и создание публикаций занимают
  // секунды, человек в панели ждёт результат. Очередь появится с кроном на этапе 8.
  router.post('/posts/:id/publish', async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    try {
      const post = await posts.findById(id);
      if (!post) throw new Error(`Поста #${id} нет`);

      const raw = req.body.group_ids;
      const groupIds = (Array.isArray(raw) ? raw : [raw])
        .filter(Boolean)
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => !Number.isNaN(value));
      if (groupIds.length === 0) throw new Error('Не выбрана ни одна группа');

      const result = await publishPost(post, { groupIds });
      const ok = result.published
        .map((item) => `${item.group.name} → публикация ${item.publication.id}`)
        .join('; ');
      const bad = result.failed.map((item) => `${item.group.name}: ${item.error.message}`).join('; ');
      const summary =
        `${result.mode === 'live' ? 'Опубликовано' : 'Черновики созданы'} ` +
        `(file_id ${result.fileId}${result.fileReused ? ', переиспользован' : ''}, ` +
        `время ${result.postAt}): ${ok}` + (bad ? `. Не ушло — ${bad}` : '');
      res.redirect(`/posts/${id}?ok=${encodeURIComponent(summary)}`);
    } catch (error) {
      logger.error({ пост: id, ...errFields(error) }, 'Публикация из панели упала');
      res.redirect(`/posts/${id}?err=${encodeURIComponent(error.message)}`);
    }
  });

  // Удаление публикации (в том числе черновика) — нужно для приёмки: черновик из UAT
  // не должен оставаться в postmypost навсегда.
  router.post('/publications/:id/delete', async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const postId = Number.parseInt(req.body.post_id, 10);
    try {
      const list = await publications.listByPost(postId);
      // Number(): publications.id — bigserial, node-pg отдаёт его строкой, и строгое
      // сравнение со числом из URL не сходится никогда.
      const row = list.find((item) => Number(item.id) === id);
      if (!row) throw new Error(`Публикации #${id} нет`);
      if (!row.pmp_publication_id) throw new Error('У записи нет id публикации в postmypost');

      // findAnyById: группа могла быть убрана из списка, но её публикацию всё равно
      // нужно уметь удалить в postmypost.
      const group = await groups.findAnyById(row.group_id);
      await pmp.deletePublication(row.pmp_publication_id, [group.pmp_account_id]);
      await publications.remove(row.id);
      // Пост держит статус «опубликован», пока у него есть хоть одна живая публикация.
      if (!(await publications.hasSuccess(postId))) await posts.markReady(postId);
      logger.info(
        { публикация: row.pmp_publication_id, группа: group.name, кто: req.user.login },
        `Публикация ${row.pmp_publication_id} удалена из postmypost`,
      );
      res.redirect(`/posts/${postId}?ok=${encodeURIComponent(`Публикация ${row.pmp_publication_id} удалена`)}`);
    } catch (error) {
      logger.error({ публикация: id, ...errFields(error) }, 'Удаление публикации упало');
      res.redirect(`/posts/${postId}?err=${encodeURIComponent(error.message)}`);
    }
  });

  router.get('/posts/:id', async (req, res, next) => {
    try {
      const post = await posts.findById(Number.parseInt(req.params.id, 10));
      if (!post) return res.status(404).type('html').send(
        page({ title: 'Пост', active: '/posts', user: req.user, heading: 'Пост не найден',
               sub: '', body: '<div class="card">Такого поста нет.</div>' }),
      );

      const body = `
        <div class="card">
          <table>
            <tr><th>Тема</th><td><code>${esc(post.topic_key ?? '—')}</code></td></tr>
            <tr><th>Источник</th><td>${esc(post.source_code ?? '—')}
              ${post.article_url ? `<br><a href="${esc(post.article_url)}" target="_blank" rel="noopener" class="hint">${esc(post.article_url)}</a>` : ''}</td></tr>
            <tr><th>Модель</th><td>${esc(post.model ?? '—')} ${esc(post.provider ? `(${post.provider})` : '')}</td></tr>
            <tr><th>Версия промта</th><td>${esc(post.prompt_version ?? '—')}</td></tr>
            <tr><th>Токенов</th><td>вход ${esc(post.tokens_in ?? '—')}, выход ${esc(post.tokens_out ?? '—')}</td></tr>
            <tr><th>Стоимость</th><td>${post.cost_usd ? `$${Number(post.cost_usd).toFixed(6)}` : '—'}</td></tr>
            <tr><th>Латентность</th><td>${esc(post.latency_ms ?? '—')} мс, попыток ${esc(post.attempts)}</td></tr>
            <tr><th>Длина</th><td>${post.char_count} символов</td></tr>
            <tr><th>request-id</th><td><code>${esc(post.request_id ?? '—')}</code></td></tr>
          </table>
        </div>
        <div class="card">
          <h2 style="margin-top:0">Обложка</h2>
          ${post.image_url
            ? `<p style="margin:0 0 10px"><a href="${esc(post.image_url)}" target="_blank"
                 rel="noopener"><img src="${esc(post.image_url)}" alt="Обложка поста"
                 style="max-width:100%;border-radius:8px"></a></p>
               <table>
                 <tr><th>Публичный URL</th><td><a href="${esc(post.image_url)}" target="_blank"
                   rel="noopener">${esc(post.image_url)}</a></td></tr>
                 <tr><th>Файл на диске</th><td><code>${esc(post.image_path ?? '—')}</code></td></tr>
                 <tr><th>Задача kie.ai</th><td><code>${esc(post.image_task_id ?? '—')}</code></td></tr>
                 <tr><th>Версия промта обложки</th><td>${esc(post.image_prompt_version ?? '—')}</td></tr>
                 <tr><th>Кредитов / время</th><td>${esc(post.image_credits ?? '—')} ·
                   ${post.image_latency_ms ? `${Math.round(post.image_latency_ms / 1000)} c` : '—'}</td></tr>
                 <tr><th>Сделана</th><td>${esc(formatDate(post.image_generated_at))}</td></tr>
               </table>
               <p class="hint" style="margin:10px 0 0">
                 Мини-превью — так обложка выглядит в ленте:
                 <img src="${esc(post.image_url)}" alt="" style="width:160px;vertical-align:middle;
                   border-radius:4px;margin-left:8px"></p>`
            : `<p class="hint" style="margin:0 0 10px">Обложки ещё нет.${
                post.image_error ? ` Прошлая попытка: ${esc(post.image_error)}` : ''
              }${
                post.image_task_id
                  ? ` Есть незавершённая задача <code>${esc(post.image_task_id)}</code> —
                      она уже оплачена, повторный запуск дочитает её, а не создаст новую.`
                  : ''
              }</p>`}
          <form method="post" action="/posts/${post.id}/image" style="margin-top:10px">
            <button ${post.image_url ? 'class="ghost"' : ''} type="submit">${
              post.image_url ? 'Сгенерировать заново' : 'Сгенерировать обложку'
            }</button>
          </form>
        </div>
        <div class="card">
          <h2 style="margin-top:0">Публикация в ВК</h2>
          ${await publicationsTable(post.id)}
          ${post.image_url
            ? await publishForm(post)
            : '<p class="hint" style="margin:0">Публиковать нечего: у поста нет обложки.</p>'}
        </div>
        <div class="card">
          <h2 style="margin-top:0">${esc(post.title)}</h2>
          ${post.error ? `<p class="hint">Ошибка: ${esc(post.error)}</p>` : ''}
          <pre style="white-space:pre-wrap;font:inherit;margin:0">${esc(post.body)}</pre>
        </div>`;

      res.type('html').send(
        page({
          title: `Пост #${post.id}`,
          active: '/posts',
          user: req.user,
          heading: `Пост #${post.id}`,
          sub: 'Текст в том виде, в котором уйдёт на стену группы.',
          message: buildSourceMessage(req.query),
          body,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  // ── Группы ВК ────────────────────────────────────────────────────────────
  router.get('/groups', async (req, res, next) => {
    try {
      const list = await groups.listAll();
      const removed = await groups.listDeleted();
      const totals = await groups.countAll();
      const defaultPerDay = await settings.getInt('default_posts_per_day', 10);

      // Остаток на сегодня по каждой включённой группе — это и есть план следующего
      // прогона: столько постов группа ещё примет с учётом «постов в день».
      const planned = list
        .filter((group) => group.is_active)
        .reduce((sum, group) => sum + Math.max(0, group.posts_per_day - group.published_today), 0);

      const rows = list.length
        ? list
            .map((group) => {
              const broken = group.connection_status !== null
                && Number(group.connection_status) !== pmp.CONNECTION_OK;
              const left = Math.max(0, group.posts_per_day - group.published_today);
              return `<tr>
                <td><strong>${esc(group.name)}</strong><br>
                    <span class="hint">${esc(group.login ?? '')} · аккаунт
                    ${group.pmp_account_id}${
                      group.external_id ? ` · ВК ${esc(group.external_id)}` : ''
                    }</span></td>
                <td>
                  <form class="inline" method="post" action="/groups/${group.id}/posts-per-day">
                    <input type="number" name="posts_per_day" min="0" max="100"
                           value="${group.posts_per_day}" style="width:70px">
                    <button class="ghost small" type="submit">Сохранить</button>
                  </form>
                </td>
                <td>${group.published_today} из ${group.posts_per_day}
                    <br><span class="hint">${
                      group.is_active
                        ? (left ? `примет ещё ${left}` : 'лимит на сегодня исчерпан')
                        : 'группа выключена'
                    }</span></td>
                <td>${group.publications}</td>
                <td>${connectionTag(group)}<br>
                    <span class="hint">${esc(formatDate(group.synced_at) || 'не синхронизирована')}</span></td>
                <td>${group.is_active
                    ? '<span class="tag on">включена</span>'
                    : '<span class="tag off">выключена</span>'}</td>
                <td style="white-space:nowrap">
                  <form class="inline" method="post" action="/groups/${group.id}/toggle">
                    <button class="ghost small" type="submit"${broken && !group.is_active ? ' disabled' : ''}>${
                      group.is_active ? 'Выключить' : 'Включить'
                    }</button>
                  </form>
                  <form class="inline" method="post" action="/groups/${group.id}/delete">
                    <button class="ghost small" type="submit">Убрать из списка</button>
                  </form>
                </td>
              </tr>`;
            })
            .join('\n')
        : `<tr><td colspan="7" class="empty">Групп нет. Подключите группу ВК в postmypost
             и нажмите «Обновить список из postmypost».</td></tr>`;

      const removedBlock = removed.length
        ? `<h2>Убранные из списка</h2>
           <div class="card">
             <p class="hint" style="margin:0 0 10px">
               Группа скрыта, но не удалена: история публикаций по ней цела и видна
               в карточках постов. Обновление списка из postmypost скрытую группу
               обратно не возвращает — только кнопка ниже.
             </p>
             <table>
               <thead><tr><th>Группа</th><th>Публикаций</th><th>Убрана</th><th></th></tr></thead>
               <tbody>${removed
                 .map(
                   (group) => `<tr>
                     <td>${esc(group.name)}<br><span class="hint">аккаунт ${group.pmp_account_id}</span></td>
                     <td>${group.publications}</td>
                     <td class="hint">${esc(formatDate(group.deleted_at))}</td>
                     <td><form class="inline" method="post" action="/groups/${group.id}/restore">
                           <button class="ghost small" type="submit">Вернуть в список</button>
                         </form></td>
                   </tr>`,
                 )
                 .join('\n')}</tbody>
             </table>
           </div>`
        : '';

      const body = `
        <div class="grid">
          ${stat(`${totals.active} из ${totals.total}`, 'Групп включено')}
          ${stat(planned, 'Постов примут сегодня')}
          ${stat(totals.deleted, 'Убрано из списка')}
          ${stat(defaultPerDay, 'Постов в день по умолчанию')}
        </div>
        <div class="card">
          <table>
            <thead><tr>
              <th>Группа</th><th>Постов в день</th><th>Сегодня</th><th>Публикаций</th>
              <th>Подключение</th><th>Статус</th><th></th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div style="margin-top:14px">
            <form method="post" action="/groups/sync">
              <input type="hidden" name="back" value="/groups">
              <button type="submit">Обновить список из postmypost</button>
            </form>
          </div>
          <p class="hint" style="margin:10px 0 0">
            Группы берутся из проекта postmypost (только ВК), числовые id вручную вводить
            не нужно: подключили группу там - нажали кнопку здесь. «Постов в день»
            ограничивает публикации в группу за сутки по МСК; выключенная группа посты
            не получает.
          </p>
        </div>
        ${removedBlock}`;

      res.type('html').send(
        page({
          title: 'Группы ВК',
          active: '/groups',
          user: req.user,
          heading: 'Группы ВК',
          sub: 'Список приходит из postmypost. Клиент включает нужные группы и задаёт объём постинга.',
          message: buildSourceMessage(req.query),
          body,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post('/groups/:id/toggle', async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    try {
      const group = await groups.findById(id);
      if (!group) throw new Error(`Группы #${id} нет`);
      await groups.setActive(group.id, !group.is_active);
      logger.info(
        { группа: group.name, включена: !group.is_active, кто: req.user.login },
        `Группа «${group.name}» ${!group.is_active ? 'включена' : 'выключена'}`,
      );
      res.redirect(
        `/groups?ok=${encodeURIComponent(
          `Группа «${group.name}» ${!group.is_active ? 'включена' : 'выключена'}`,
        )}`,
      );
    } catch (error) {
      logger.error({ группа: id, ...errFields(error) }, 'Переключение группы упало');
      res.redirect(`/groups?err=${encodeURIComponent(error.message)}`);
    }
  });

  router.post('/groups/:id/posts-per-day', async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    try {
      const group = await groups.setPostsPerDay(id, req.body.posts_per_day);
      logger.info(
        { группа: group.name, постов_в_день: group.posts_per_day, кто: req.user.login },
        `Группа «${group.name}»: постов в день теперь ${group.posts_per_day}`,
      );
      res.redirect(
        `/groups?ok=${encodeURIComponent(
          `Группа «${group.name}»: постов в день ${group.posts_per_day}`,
        )}`,
      );
    } catch (error) {
      logger.error({ группа: id, ...errFields(error) }, 'Смена «постов в день» упала');
      res.redirect(`/groups?err=${encodeURIComponent(error.message)}`);
    }
  });

  // Удаление мягкое: история публикаций по группе должна остаться читаемой,
  // а физический DELETE её уносит (и с этапа 7 запрещён на уровне схемы).
  router.post('/groups/:id/delete', async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    try {
      const group = await groups.softDelete(id);
      if (!group) throw new Error(`Группы #${id} нет или она уже убрана`);
      logger.warn(
        { группа: group.name, кто: req.user.login },
        `Группа «${group.name}» убрана из списка (история публикаций сохранена)`,
      );
      res.redirect(
        `/groups?ok=${encodeURIComponent(
          `Группа «${group.name}» убрана из списка. История публикаций сохранена, ` +
            'группу можно вернуть.',
        )}`,
      );
    } catch (error) {
      logger.error({ группа: id, ...errFields(error) }, 'Удаление группы упало');
      res.redirect(`/groups?err=${encodeURIComponent(error.message)}`);
    }
  });

  router.post('/groups/:id/restore', async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    try {
      const group = await groups.restore(id);
      if (!group) throw new Error(`Группы #${id} нет среди убранных`);
      logger.info({ группа: group.name, кто: req.user.login }, `Группа «${group.name}» возвращена в список`);
      res.redirect(
        `/groups?ok=${encodeURIComponent(
          `Группа «${group.name}» возвращена в список выключенной — включите её, когда нужно`,
        )}`,
      );
    } catch (error) {
      logger.error({ группа: id, ...errFields(error) }, 'Восстановление группы упало');
      res.redirect(`/groups?err=${encodeURIComponent(error.message)}`);
    }
  });

  // ── Разделы будущих этапов ───────────────────────────────────────────────
  const stubs = [
    ['/manual', 'Ручной режим', 9, 'Вставить ссылку или тему — система сделает пост в выбранную группу.'],
    ['/runs', 'Прогоны', 11, 'История запусков: найдено, сгенерировано, опубликовано, ошибки, request-id.'],
    ['/published', 'Опубликовано', 11, 'Лог постов: группа, тема, время, ссылка на пост в ВК, обложка.'],
  ];

  /** Что уже уехало (или не уехало) по этому посту. */
  async function publicationsTable(postId) {
    const list = await publications.listByPost(postId);
    if (list.length === 0) {
      return '<p class="hint" style="margin:0 0 12px">Публикаций по этому посту ещё нет.</p>';
    }
    const rows = list
      .map(
        (item) => `<tr>
          <td>${esc(item.group_name)}<br><span class="hint">${esc(item.group_login ?? '')}</span></td>
          <td>${item.error
              ? `<span class="tag off">сбой</span> <span class="hint">${esc(item.error)}</span>`
              : `${publishModeTag(item.mode)} <span class="hint">статус ${esc(item.pmp_status ?? '—')}</span>`}</td>
          <td><code>${esc(item.pmp_publication_id ?? '—')}</code>
              <br><span class="hint">file_id ${esc(item.pmp_file_id ?? '—')}</span></td>
          <td class="hint">${esc(formatDate(item.post_at))}</td>
          <td>${item.pmp_publication_id
              ? `<form class="inline" method="post" action="/publications/${item.id}/delete">
                   <input type="hidden" name="post_id" value="${postId}">
                   <button class="ghost small" type="submit">Удалить в postmypost</button>
                 </form>`
              : ''}</td>
        </tr>`,
      )
      .join('\n');
    return `<table style="margin-bottom:14px">
        <thead><tr><th>Группа</th><th>Режим</th><th>ID в postmypost</th><th>Время</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  /**
   * Форма публикации: выбор групп + кнопка.
   *
   * Выключенная группа в выборе есть, но недоступна: так видно, почему пост в неё
   * не уйдёт, и сразу понятно, где это менять (раздел «Группы»). Дневной лимит
   * показывается рядом — публикация сверх него отказывает на уровне сервиса.
   */
  async function publishForm(post) {
    const list = await groups.listAll();
    const mode = await settings.get('publish_mode', 'draft');
    const syncButton = `<form class="inline" method="post" action="/groups/sync">
        <input type="hidden" name="back" value="/posts/${post.id}">
        <button class="ghost small" type="submit">Обновить список групп из postmypost</button>
      </form>`;

    if (list.length === 0) {
      return `<p class="hint" style="margin:0 0 10px">
          Групп в базе нет. Список берётся из postmypost: подключите группу ВК там
          и нажмите кнопку ниже.</p>
        ${syncButton}`;
    }

    const checks = list
      .map((group) => {
        const broken = group.connection_status !== null
          && Number(group.connection_status) !== pmp.CONNECTION_OK;
        const left = Math.max(0, group.posts_per_day - group.published_today);
        const blocked = broken || !group.is_active;
        const notes = [
          esc(group.login ?? ''),
          `аккаунт ${group.pmp_account_id}`,
          `сегодня ${group.published_today} из ${group.posts_per_day}`,
        ];
        if (!group.is_active) notes.push('<span class="tag off">выключена</span>');
        if (broken) notes.push('<span class="tag off">отключён</span>');
        if (group.is_active && !broken && left === 0) notes.push('лимит на сегодня исчерпан');
        return `<label style="display:block;margin-bottom:6px">
            <input type="checkbox" name="group_ids" value="${group.id}"
              ${blocked ? 'disabled' : 'checked'}>
            ${esc(group.name)}
            <span class="hint">${notes.filter(Boolean).join(' · ')}</span>
          </label>`;
      })
      .join('\n');

    return `<form method="post" action="/posts/${post.id}/publish">
        <div style="margin:0 0 10px">${checks}</div>
        <button type="submit">${
          mode === 'live' ? 'Опубликовать на стену' : 'Создать черновик в postmypost'
        }</button>
        <span class="hint" style="margin-left:8px">режим: ${publishModeTag(mode)}</span>
      </form>
      <p class="hint" style="margin:10px 0 0">
        Картинка заливается в postmypost один раз и переиспользуется всеми выбранными
        группами. Режим переключается в разделе «Настройки», состав групп и объём
        постинга - в разделе «Группы». ${syncButton}</p>`;
  }

  /**
   * Карточка прогона: план на следующий запуск, кнопка ручного запуска и итог последнего.
   *
   * План строится «на лету» из тех же правил, что использует сам прогон, — так видно,
   * что уйдёт в какую группу и в какое время, до того как что-то опубликовано.
   */
  async function runCard(lastCycle) {
    const plan = await buildPlan();
    const map = await settings.getMap();
    const planRows = plan.items.length
      ? plan.items
          .map(
            (item) => `<tr>
              <td>${item.slotNo}</td>
              <td>${esc(item.groupName)}</td>
              <td>${esc(item.label ?? '')}<br><span class="hint">${
                item.kind === 'post' ? 'пост готов' : 'нужна генерация'
              }${item.date ? ` · материал от ${esc(formatDate(item.date))}` : ''}</span></td>
              <td class="hint">${esc(formatDate(item.postAt))}</td>
            </tr>`,
          )
          .join('\n')
      : `<tr><td colspan="4" class="empty">${esc(plan.reason ?? 'Планировать нечего')}</td></tr>`;

    const quotas = plan.groups.length
      ? plan.groups
          .map(
            (row) => `${esc(row.group.name)}: ${row.quota} из ${row.group.posts_per_day}` +
              (row.publishedToday ? ` <span class="hint">(сегодня уже ${row.publishedToday})</span>` : ''),
          )
          .join(' · ')
      : 'нет включённых групп';

    const lastBlock = lastCycle
      ? `<h2>Последний прогон</h2>
         <div class="card">
           <table>
             <tr><th>Прогон</th><td>#${lastCycle.id} ${runKindText(lastCycle.kind)},
               ${runStatusTag(lastCycle.status)}</td></tr>
             <tr><th>Время</th><td>${esc(formatDate(lastCycle.started_at))} →
               ${esc(formatDate(lastCycle.finished_at) || 'ещё идёт')}</td></tr>
             <tr><th>Итог</th><td>слотов ${lastCycle.found}, сгенерировано
               ${lastCycle.generated}, опубликовано ${lastCycle.published}</td></tr>
             ${lastCycle.error
               ? `<tr><th>Ошибки</th><td class="hint">${esc(lastCycle.error)}</td></tr>`
               : ''}
             <tr><th>request-id</th><td><code>${esc(lastCycle.request_id)}</code></td></tr>
           </table>
           ${await runItemsTable(lastCycle.id)}
         </div>`
      : '';

    return `<div class="card">
        <p style="margin:0 0 10px">Квоты на сегодня: ${quotas}</p>
        <p class="hint" style="margin:0 0 10px">
          Времена слотов считаются от окна публикаций ${esc(map.posting_window_start)}-${
            esc(map.posting_window_end)} МСК${
            map.schedule_mode === 'interval'
              ? `, но не дальше чем на ${esc(map.schedule_interval_hours)} ч от старта:
                 при расписании «каждые ${esc(map.schedule_interval_hours)} ч» посты должны
                 уложиться до следующего прогона`
              : ' (расписание «раз в день» растягивает посты на всё окно)'
          }. Если окно на сегодня уже закрыто, прогон встаёт на завтрашнее.
        </p>
        <table>
          <thead><tr><th>Слот</th><th>Группа</th><th>Материал</th><th>Время публикации</th></tr></thead>
          <tbody>${planRows}</tbody>
        </table>
        <div style="margin-top:14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <form method="post" action="/run" style="display:flex;gap:8px;align-items:center">
            <label class="hint">не больше
              <input type="number" name="limit_per_group" min="1" max="100" value=""
                     placeholder="все" style="width:70px"> постов на группу</label>
            <button type="submit"${plan.items.length ? '' : ' disabled'}>Запустить прогон</button>
          </form>
        </div>
        <p class="hint" style="margin:10px 0 0">
          Один материал уходит ровно в одну группу, порядок внутри группы - от свежих
          к старым, времена разнесены по слотам внутри окна публикаций. Прогон делает
          всю цепочку: текст, обложка, публикация. Второй запуск во время первого
          отклоняется.${plan.reason && plan.items.length ? ` ${esc(plan.reason)}` : ''}
        </p>
      </div>
      ${lastBlock}`;
  }

  /** Слоты прогона: что уехало, что нет, с временем и ошибкой. */
  async function runItemsTable(runId) {
    const items = await runs.listItems(runId);
    if (items.length === 0) return '';
    const rows = items
      .map(
        (item) => `<tr>
          <td>${item.slot_no}</td>
          <td>${esc(item.group_name)}</td>
          <td>${item.post_id
              ? `<a href="/posts/${item.post_id}">${esc(item.post_title ?? `пост #${item.post_id}`)}</a>`
              : esc(item.topic_name ?? '(материал)')}</td>
          <td class="hint">${esc(formatDate(item.post_at))}</td>
          <td>${runItemTag(item)}</td>
        </tr>`,
      )
      .join('\n');
    return `<table style="margin-top:14px">
        <thead><tr><th>Слот</th><th>Группа</th><th>Пост</th><th>Время</th><th>Состояние</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  // Ручной запуск прогона. Синхронный: человек в панели ждёт результат, а cron
  // с тем же вызовом появится на этапе 9.
  router.post('/run', async (req, res) => {
    try {
      const raw = Number.parseInt(req.body.limit_per_group, 10);
      const limitPerGroup = Number.isNaN(raw) ? undefined : raw;
      const result = await runCycle({ kind: 'manual', limitPerGroup });
      const summary =
        `Прогон #${result.runId}${result.resumed ? ' (продолжен)' : ''}: опубликовано ` +
        `${result.published} из ${result.planned}` +
        (result.generated ? `, сгенерировано ${result.generated}` : '') +
        (result.failed ? `, сбоев ${result.failed}` : '') +
        `, ${Math.round(result.ms / 1000)} c`;
      res.redirect(`/?ok=${encodeURIComponent(summary)}`);
    } catch (error) {
      logger.error(errFields(error), 'Прогон из панели упал');
      res.redirect(`/?err=${encodeURIComponent(error.message)}`);
    }
  });

  /** Карточка промта: правка, история версий, откат. */
  async function promptCard(key, title, rows, hint) {
    const active = await prompts.getActive(key);
    const versions = await prompts.listVersions(key, 10);
    const history = versions
      .map(
        (item) => `<tr>
          <td>v${item.version}${item.is_active ? ' <span class="tag on">активна</span>' : ''}</td>
          <td class="hint">${item.length} симв.</td>
          <td class="hint">${esc(item.note ?? '')}</td>
          <td class="hint">${esc(item.created_by ?? '')}<br>${esc(formatDate(item.created_at))}</td>
          <td>${item.is_active ? '' : `<form class="inline" method="post"
                action="/prompts/${key}/activate/${item.version}">
                <button class="ghost small" type="submit">Вернуть эту</button></form>`}</td>
        </tr>`,
      )
      .join('\n');

    return `<div class="card">
      <h2 style="margin-top:0">${esc(title)}</h2>
      <div class="hint" style="margin-bottom:8px">
        Активна версия ${esc(active?.version ?? '—')}, ${active?.body.length ?? 0} символов. ${esc(hint)}
      </div>
      <form method="post" action="/prompts/${key}">
        <textarea name="body" rows="${rows}">${esc(active?.body ?? '')}</textarea>
        <div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input type="text" name="note" placeholder="что поменяли (необязательно)" style="flex:1;min-width:220px">
          <button type="submit">Сохранить новую версию</button>
        </div>
      </form>
      <h3 style="margin:18px 0 6px;font-size:14px">История версий</h3>
      <table>
        <tbody>${history}</tbody>
      </table>
    </div>`;
  }

  for (const [href, title, stage, what] of stubs) {
    router.get(href, (req, res) => {
      res.type('html').send(
        page({
          title,
          active: href,
          user: req.user,
          heading: title,
          sub: 'Раздел появится на своём этапе.',
          body: soon(stage, what),
        }),
      );
    });
  }

  return router;
}

/** Миниатюра обложки в списке постов: 96 px — сразу видно, читается ли текст мелким. */
function thumbCell(item) {
  if (item.image_url) {
    return `<a href="/posts/${item.id}"><img src="${esc(item.image_url)}" alt=""
      style="width:96px;border-radius:4px;display:block"></a>`;
  }
  if (item.image_error) return `<span class="tag off">сбой</span>`;
  return '<span class="hint">нет</span>';
}

/**
 * Остаток кредитов kie.ai. Живой запрос к провайдеру, поэтому в панели он не должен
 * ломать страницу: недоступный kie.ai не повод не показать список постов.
 */
async function creditsText() {
  if (!kie.isConfigured()) return 'ключ не задан';
  try {
    const left = await kie.credits();
    return left === null ? '?' : left;
  } catch (error) {
    logger.warn(errFields(error), 'Не удалось узнать остаток кредитов kie.ai');
    return 'недоступно';
  }
}

function stat(value, label) {
  return `<div class="card stat"><div class="n">${esc(value)}</div><div class="l">${esc(label)}</div></div>`;
}

/**
 * Состояние подключения аккаунта в postmypost. У ВК токен истекает (по брифу — раз
 * в три месяца), и клиент должен видеть это в списке, а не узнавать из сбоя постинга.
 */
function connectionTag(group) {
  if (group.connection_status === null) return '<span class="hint">неизвестно</span>';
  if (Number(group.connection_status) === pmp.CONNECTION_OK) {
    return '<span class="tag on">подключена</span>';
  }
  return `<span class="tag off">отвалилась</span>
    <span class="hint">статус ${esc(group.connection_status)} — переподключите в postmypost</span>`;
}

/** Числовое поле формы с понятной ошибкой вместо «violates check constraint». */
function requireInt(value, min, max, label) {
  const number = Number.parseInt(String(value ?? '').trim(), 10);
  if (Number.isNaN(number) || number < min || number > max) {
    throw new Error(`${label}: нужно целое число от ${min} до ${max}`);
  }
  return number;
}

function requireHhMm(value, label) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,2}:\d{2}$/.test(text)) throw new Error(`${label}: нужно время в формате ЧЧ:ММ`);
  const [hours, minutes] = text.split(':').map((part) => Number.parseInt(part, 10));
  if (hours > 23 || minutes > 59) throw new Error(`${label}: такого времени не существует`);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function runKindText(kind) {
  return { cron: 'по расписанию', manual: 'вручную', backfill: 'из архива',
    source_check: 'проверка источника' }[kind] ?? kind;
}

function runStatusTag(status) {
  if (status === 'done') return '<span class="tag on">завершён</span>';
  if (status === 'failed') return '<span class="tag off">сбой</span>';
  return '<span class="tag soon">идёт</span>';
}

function runItemTag(item) {
  if (item.status === 'published') return '<span class="tag on">опубликован</span>';
  if (item.status === 'failed') {
    return `<span class="tag off">сбой</span> <span class="hint">${esc(item.error ?? '')}</span>`;
  }
  if (item.status === 'generated') return '<span class="tag soon">текст готов</span>';
  if (item.status === 'skipped') return '<span class="tag off">пропущен</span>';
  return '<span class="tag soon">в плане</span>';
}

function publishModeTag(mode) {
  return mode === 'live'
    ? '<span class="tag on">реальная публикация</span>'
    : '<span class="tag soon">черновики</span>';
}

function discoveryText(item) {
  if (item.discovery === 'sitemap') return `sitemap: ${item.sitemap_pattern}`;
  return 'свой адаптер';
}

function fetchViaText(via) {
  if (via === 'wp_api') return 'WP REST API';
  if (via === 'firecrawl') return 'firecrawl';
  return 'прямой запрос';
}

/** Тема материала: ключ дедупа и то, откуда он получен (подсказка/заголовок/адрес). */
function topicCell(item) {
  if (!item.topic_key) return '<span class="hint">—</span>';
  const via = { hint: 'из подсказки', title: 'из заголовка', slug: 'из адреса' }[item.topic_via];
  return `<code>${esc(item.topic_key)}</code><br><span class="hint">${esc(via ?? '')}</span>`;
}

function statusTag(item) {
  if (item.status === 'failed') {
    return `<span class="tag soon">сбой</span> <span class="hint">${esc(item.skip_reason ?? '')}</span>`;
  }
  // Отклонённый материал показывает причину: дубль темы (с номером «победителя»)
  // или служебная страница-листинг.
  if (item.status === 'duplicate') {
    return `<span class="tag off">отклонён</span> <span class="hint">${esc(item.skip_reason ?? 'дубль темы')}</span>`;
  }
  if (item.status === 'skipped') {
    return `<span class="tag off">пропущен</span> <span class="hint">${esc(item.skip_reason ?? '')}</span>`;
  }
  if (item.content_mode === 'topic_only') {
    return '<span class="tag on">тема готова</span> <span class="hint">текст не нужен</span>';
  }
  if (item.has_text) {
    return `<span class="tag on">текст есть</span> <span class="hint">${item.text_len} симв.</span>`;
  }
  return '<span class="tag off">ждёт извлечения</span>';
}

function buildSourceMessage(q) {
  if (q.err) return { kind: 'err', text: String(q.err) };
  if (q.ok) return { kind: 'ok', text: String(q.ok) };
  return null;
}

function formatDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
}
