import { Router } from 'express';
import { requireAuth } from '../../auth/middleware.js';
import { page, esc } from '../views/layout.js';
import { query } from '../../db/pool.js';
import * as sources from '../../repo/sources.js';
import * as settings from '../../repo/settings.js';
import * as articles from '../../repo/articles.js';
import * as prompts from '../../repo/prompts.js';
import * as posts from '../../repo/posts.js';
import { checkSource } from '../../services/check-source.js';
import { generatePost } from '../../services/generate-post.js';
import { generateImageForPost } from '../../services/generate-image.js';
import * as kie from '../../lib/kie.js';
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
          (SELECT count(DISTINCT topic_key) FROM articles
            WHERE topic_key IS NOT NULL AND status <> 'duplicate') AS topics,
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

  // ── Разделы будущих этапов ───────────────────────────────────────────────
  const stubs = [
    ['/groups', 'Группы ВК', 7, 'Список групп подтягивается из postmypost, клиент включает нужные и задаёт число постов в день.'],
    ['/manual', 'Ручной режим', 9, 'Вставить ссылку или тему — система сделает пост в выбранную группу.'],
    ['/runs', 'Прогоны', 11, 'История запусков: найдено, сгенерировано, опубликовано, ошибки, request-id.'],
    ['/published', 'Опубликовано', 11, 'Лог постов: группа, тема, время, ссылка на пост в ВК, обложка.'],
  ];

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
