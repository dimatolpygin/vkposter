import * as pmp from '../lib/postmypost.js';
import * as groups from '../repo/groups.js';
import { log } from '../logger.js';

const logger = log('группы');

/**
 * Список групп ВК из postmypost → в БД.
 *
 * Клиент подключает группу в postmypost, а числовые id в панель не вписывает.
 * Полноценный раздел «Группы» (вкл/выкл, постов в день) — этап 7; здесь синхронизация,
 * без которой публиковать некуда.
 *
 * Фильтр по `chanel_id = 2` (ВК) стоит в клиенте: в проекте могут быть и Telegram,
 * и Instagram, а этот проект — про ВК.
 */
export async function syncGroups() {
  const accounts = await pmp.vkAccounts();
  let added = 0;
  let updated = 0;
  let broken = 0;

  for (const account of accounts) {
    const row = await groups.upsertFromPmp(account);
    if (row.inserted) added += 1;
    else updated += 1;
    if (Number(account.connection_status) !== pmp.CONNECTION_OK) broken += 1;
  }

  logger.info(
    { всего: accounts.length, добавлено: added, обновлено: updated, отвалилось: broken },
    `Групп ВК в postmypost: ${accounts.length} (новых ${added}, отвалившихся ${broken})`,
  );
  return { total: accounts.length, added, updated, broken };
}
