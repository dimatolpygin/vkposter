import { Router } from 'express';
import { requireAuth } from '../../auth/middleware.js';
import { page, esc } from '../views/layout.js';
import { query } from '../../db/pool.js';
import * as sources from '../../repo/sources.js';
import * as settings from '../../repo/settings.js';
import * as articles from '../../repo/articles.js';
import { checkSource } from '../../services/check-source.js';
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
          (SELECT count(*) FROM groups WHERE is_active)    AS groups_active,
          (SELECT count(*) FROM articles)                  AS articles,
          (SELECT count(*) FROM posts)                     AS posts,
          (SELECT count(*) FROM publications)              AS publications,
          (SELECT count(*) FROM runs)                      AS runs
      `);
      const s = rows[0];
      const map = await settings.getMap();

      const body = `
        <div class="grid">
          ${stat(`${s.sources_active} из ${s.sources_total}`, 'Источников активно')}
          ${stat(s.groups_active, 'Групп ВК активно')}
          ${stat(s.articles, 'Материалов найдено')}
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
            <tr><th>Режим публикации</th><td>${publishModeTag(map.publish_mode)}</td></tr>
            <tr><th>Длина поста</th><td>${esc(map.post_min_chars)}-${esc(map.post_max_chars)} символов</td></tr>
          </table>
        </div>
        <h2>Статус последнего прогона</h2>
        ${soon(9, 'Появится вместе с автономным прогоном по расписанию.')}`;

      res.type('html').send(
        page({
          title: 'Обзор',
          active: '/',
          user: req.user,
          heading: 'Обзор',
          sub: 'Сводка по системе. Разделы наполняются по мере прохождения этапов.',
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

      const rows = list
        .map((item) => {
          const st = stats.get(item.id) ?? { total: 0, with_text: 0, failed: 0, newest: null };
          return `<tr>
            <td><strong>${esc(item.title)}</strong><br><span class="hint">${esc(item.base_url)}</span></td>
            <td>${esc(discoveryText(item))}</td>
            <td>${esc(item.content_mode === 'text' ? 'рерайт статьи' : 'только тема')}</td>
            <td>${esc(fetchViaText(item.fetch_via))}</td>
            <td>${st.total}${st.with_text ? ` <span class="hint">(с текстом ${st.with_text})</span>` : ''}${
              st.failed ? ` <span class="tag soon">сбоев ${st.failed}</span>` : ''
            }</td>
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
          <tr><td colspan="8" class="hint" style="padding-top:0">${esc(item.notes ?? '')}</td></tr>`;
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
                <td class="hint">${esc(formatDate(item.lastmod))}</td>
                <td>${statusTag(item)}</td>
              </tr>`,
            )
            .join('\n')
        : '<tr><td colspan="4" class="empty">Пока ничего не найдено. Нажмите «Проверить» у любого источника.</td></tr>';

      const body = `
        <div class="card">
          <table>
            <thead><tr>
              <th>Источник</th><th>Откуда берём</th><th>Режим</th><th>Доступ</th>
              <th>Материалов</th><th>Проверен</th><th>Статус</th><th></th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <form method="post" action="/sources/check-all" style="margin-top:14px">
            <button type="submit">Проверить все включённые</button>
          </form>
        </div>

        <h2>Последние найденные материалы</h2>
        <div class="card">
          <table>
            <thead><tr><th>Источник</th><th>Материал</th><th>Дата</th><th>Состояние</th></tr></thead>
            <tbody>${recentRows}</tbody>
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
        `дублей ${result.duplicates}, текстов ${result.extracted}` +
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

      const body = `
        <div class="card">
          <table>
            <thead><tr><th>Ключ</th><th>Значение</th><th>Изменено</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <h2>Редактирование</h2>
        ${soon(8, 'Формы правки окна свежести, расписания и объёма постов — вместе с планировщиком.')}`;

      res.type('html').send(
        page({
          title: 'Настройки',
          active: '/settings',
          user: req.user,
          heading: 'Настройки',
          sub: 'Значения засеяны из брифа. Правка через панель появится на этапе 8.',
          body,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  // ── Промты ───────────────────────────────────────────────────────────────
  router.get('/prompts', async (req, res, next) => {
    try {
      const postPrompt = await settings.get('post_prompt', '');
      const imagePrompt = await settings.get('image_prompt', '');

      const body = `
        <div class="card">
          <h2 style="margin-top:0">Промт текста поста</h2>
          <div class="hint" style="margin-bottom:8px">
            ${postPrompt.length} символов. Хранится в БД, правка появится на этапе 4.
          </div>
          <textarea rows="16" readonly>${esc(postPrompt)}</textarea>
        </div>
        <div class="card">
          <h2 style="margin-top:0">Промт обложки</h2>
          <div class="hint" style="margin-bottom:8px">${imagePrompt.length} символов.</div>
          <textarea rows="6" readonly>${esc(imagePrompt)}</textarea>
        </div>
        ${soon(4, 'Правка промтов с версиями и откатом.')}`;

      res.type('html').send(
        page({
          title: 'Промты',
          active: '/prompts',
          user: req.user,
          heading: 'Промты',
          sub: 'Промт клиента живёт в базе, а не в коде: правится в панели без пересборки.',
          body,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  // ── Разделы будущих этапов ───────────────────────────────────────────────
  const stubs = [
    ['/groups', 'Группы ВК', 7, 'Список групп подтягивается из postmypost, клиент включает нужные и задаёт число постов в день.'],
    ['/manual', 'Ручной режим', 9, 'Вставить ссылку или тему — система сделает пост в выбранную группу.'],
    ['/runs', 'Прогоны', 11, 'История запусков: найдено, сгенерировано, опубликовано, ошибки, request-id.'],
    ['/published', 'Опубликовано', 11, 'Лог постов: группа, тема, время, ссылка на пост в ВК, обложка.'],
  ];

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

function stat(value, label) {
  return `<div class="card stat"><div class="n">${esc(value)}</div><div class="l">${esc(label)}</div></div>`;
}

function scheduleText(map) {
  return map.schedule_mode === 'interval'
    ? `каждые ${map.schedule_interval_hours} ч`
    : `ежедневно в ${map.schedule_daily_at} МСК`;
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

function statusTag(item) {
  if (item.status === 'failed') {
    return `<span class="tag soon">сбой</span> <span class="hint">${esc(item.skip_reason ?? '')}</span>`;
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
