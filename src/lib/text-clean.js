/**
 * Постобработка сгенерированного текста.
 *
 * Зачем кодом, а не промтом: просить модель «не используй markdown и длинное тире»
 * работает через раз, а чистка регулярками работает всегда. Промт отвечает за стиль,
 * код — за чистоту разметки.
 *
 * Что НЕЛЬЗЯ трогать (осознанный стиль клиента, а не мусор):
 *   - булиты «— пункт» в начале строки: так устроен формат поста в промте;
 *   - эмодзи-иконки 🔰 ❗️ ✅ — маркеры подзаголовков и рекламного блока;
 *   - разделители «--------» вокруг рекламного блока.
 * Убирается только markdown-разметка и тире «—» ВНУТРИ предложений.
 */

/** Строка-булит: тире (или дефис) с пробелом в начале строки. Такие тире сохраняем. */
const BULLET_LINE = /^(\s*)[—–-]\s+/;

/** Ряд дефисов — разделитель рекламного блока из промта, не markdown-hr. */
const AD_SEPARATOR = /^\s*-{4,}\s*$/;

function stripMarkdownInline(line) {
  return line
    // ссылки [текст](url) → «текст (url)»: ссылку из рекламного блока терять нельзя
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, text, url) =>
      text.trim() === url.trim() ? url : `${text} ${url}`)
    // **жирный**, __жирный__, *курсив*, _курсив_
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(«"])\*([^*\n]+)\*(?=[\s).,!?»"]|$)/g, '$1$2')
    .replace(/(^|[\s(«"])_([^_\n]+)_(?=[\s).,!?»"]|$)/g, '$1$2')
    // `код` и ~~зачёркнутый~~
    .replace(/`([^`]+)`/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1');
}

/**
 * Тире внутри предложения заменяется на запятую или убирается.
 * «Проект — это развод» → «Проект это развод». Тире в начале строки (булит) сохраняется,
 * поэтому обработка идёт построчно и первый символ строки не участвует.
 */
function stripInlineDash(line) {
  const bullet = line.match(BULLET_LINE);
  const head = bullet ? bullet[0] : '';
  const rest = bullet ? line.slice(head.length) : line;
  const cleaned = rest
    // «слово — слово» → «слово слово»; двойной пробел подчищается ниже
    .replace(/\s+[—–]\s+/g, ' ')
    // «слово—слово» без пробелов
    .replace(/(\S)[—–](\S)/g, '$1 $2');
  return head + cleaned;
}

export function cleanPostText(raw) {
  if (!raw) return '';

  // Рекламный блок между строками-разделителями — дословный текст клиента.
  // Внутри него не чистим ничего, кроме markdown: там есть «— он принес нам…»,
  // и удаление этого тире ломает фразу заказчика.
  let insideAd = false;

  const lines = String(raw)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      if (AD_SEPARATOR.test(line)) {
        insideAd = !insideAd;
        return line.trim();
      }
      if (insideAd) return stripMarkdownInline(line).trimEnd();

      let out = line
        // заголовки markdown: решётки убираем, текст оставляем
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        // цитаты
        .replace(/^\s{0,3}>\s?/, '')
        // нумерованные и звёздочные списки приводим к булиту клиента
        .replace(/^\s*\d+[.)]\s+/, '— ')
        .replace(/^\s*[*+]\s+/, '— ');

      out = stripMarkdownInline(out);
      out = stripInlineDash(out);

      return out.replace(/[ \t]{2,}/g, ' ').trimEnd();
    });

  return lines
    .join('\n')
    // больше двух пустых строк подряд не нужно
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Проверка поста на соответствие требованиям промта. Возвращает список нарушений;
 * пустой список = пост годен. Генерация повторяется, пока список не опустеет.
 *
 * @param {string} text
 * @param {object} rules
 * @param {number} rules.minChars
 * @param {number} rules.maxChars
 * @param {string} rules.adLink   ссылка рекламного блока
 * @param {string} [rules.topicName] название проекта — должно быть в первом абзаце
 */
export function validatePost(text, { minChars, maxChars, adLink, topicName }) {
  const problems = [];
  const value = String(text ?? '');

  if (value.length < minChars) problems.push(`коротко: ${value.length} символов, нужно от ${minChars}`);
  if (value.length > maxChars) problems.push(`длинно: ${value.length} символов, нужно до ${maxChars}`);

  // Первый абзац — то, что до первой пустой строки, но без строки заголовка:
  // заголовок в формате клиента идёт отдельным блоком сверху.
  const blocks = value.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  const firstParagraph = (blocks[1] ?? blocks[0] ?? '').toLowerCase();

  if (!/отзыв/.test(firstParagraph)) {
    problems.push('в первом абзаце нет слова «отзыв»');
  }
  if (topicName && !mentionsProject(firstParagraph, topicName)) {
    problems.push(`в первом абзаце нет названия проекта («${topicName}»)`);
  }
  // Структура из промта клиента: два блока с булитами и блок «Итог». Проверяем кодом,
  // а не надеемся на модель: без булитов пост в ВК читается стеной текста.
  const bulletLines = value.split('\n').filter((line) => /^\s*—\s+\S/.test(line)).length;
  if (bulletLines < 4) {
    problems.push(`мало пунктов-булитов: ${bulletLines}, нужно минимум 4 (по 2-3 в двух блоках)`);
  }
  // Без \b: в JS границей слова считается только ASCII, и после кириллического «итог»
  // \b не срабатывает — проверка не находила даже строку «Итог:».
  if (!/^\s*итог/im.test(value)) {
    problems.push('нет блока «Итог»');
  }

  if (adLink && !value.includes(adLink)) {
    problems.push(`нет рекламного блока со ссылкой ${adLink}`);
  }
  if (/\*\*|^#{1,6}\s|\[[^\]]+\]\(/m.test(value)) {
    problems.push('осталась markdown-разметка');
  }

  return problems;
}

/**
 * Название проекта в первом абзаце. Сравнение нежёсткое: модель пишет «PipNest Markets»,
 * «Пипнест» или «pipnest markets» — требовать точного совпадения строки бессмысленно.
 * Достаточно самого длинного слова названия (от 4 букв) или названия без пробелов.
 */
function mentionsProject(paragraph, topicName) {
  const haystack = paragraph.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
  const name = String(topicName).toLowerCase();
  const compact = name.replace(/[^\p{L}\p{N}]+/gu, '');
  if (compact.length >= 4 && haystack.includes(compact)) return true;

  const words = name.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4);
  if (words.length === 0) return paragraph.includes(name);
  const longest = words.sort((a, b) => b.length - a.length)[0];
  return haystack.includes(longest);
}
