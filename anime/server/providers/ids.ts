// ID тайтла на Кинопоиске для Alloha: она ищет по нему, а не по Shikimori. Берём его
// из ответа Kodik (если есть токен), иначе из GraphQL Shikimori (externalLinks →
// kinopoisk). Найденное храним в базе: Shikimori разрешает 5 запросов в секунду и 90
// в минуту. CVH и Kodik ищут по ID Shikimori, он есть в ответе AniLiberty.

import type { Release } from '../../shared/types.ts';
import type { Store } from '../db.ts';
import type { ExternalIds } from './kodik.ts';

const DAY = 86_400_000;
const SHIKIMORI_PAUSE = 10 * 60_000;

export class ShikimoriApi {
  private base: string;
  private userAgent: string;
  /** После ошибки (сайт недоступен, лимит запросов) не трогаем Shikimori какое-то время. */
  private pausedUntil = 0;

  constructor(base: string, userAgent: string) {
    this.base = base;
    this.userAgent = userAgent;
  }

  /** ID Кинопоиска из внешних ссылок тайтла на Shikimori. */
  async kinopoiskId(shikimoriId: string): Promise<string | null> {
    if (Date.now() < this.pausedUntil) throw new Error('Shikimori недоступен, повторим позже');
    let response: Response;
    try {
      response = await fetch(`${this.base}/api/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': this.userAgent },
        body: JSON.stringify({
          query: 'query ($ids: String) { animes(ids: $ids, limit: 1) { id externalLinks { kind url } } }',
          variables: { ids: shikimoriId },
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      this.pausedUntil = Date.now() + SHIKIMORI_PAUSE;
      throw error;
    }
    if (!response.ok) {
      this.pausedUntil = Date.now() + SHIKIMORI_PAUSE;
      throw new Error(`Shikimori ответил ${response.status}`);
    }
    const data = (await response.json()) as { data?: { animes?: { externalLinks?: { kind: string; url: string }[] }[] } };
    for (const link of data.data?.animes?.[0]?.externalLinks ?? []) {
      // Только обычный Кинопоиск: у kinopoisk_hd в ссылке шестнадцатеричный ID другого вида.
      if (link.kind !== 'kinopoisk') continue;
      const id = /^https?:\/\/(?:www\.)?kinopoisk\.ru\/(?:film|series)\/(\d+)(?:[/?#]|$)/.exec(link.url)?.[1];
      if (id) return id;
    }
    return null;
  }
}

/** Номер сезона из названия: «2 сезон», «Сезон 2», «ТВ-3», «Season 2», «2nd Season», «II». */
export function seasonFromTitle(release: Pick<Release, 'title' | 'titleEn'>): number | null {
  const roman: Record<string, number> = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6 };
  for (const title of [release.title, release.titleEn]) {
    if (!title) continue;
    const match =
      /(\d+)(?:-?(?:й|ый|ой))?\s*сезон/i.exec(title) ??
      /сезон\s*(\d+)/i.exec(title) ??
      // \b не работает с кириллицей без флага u.
      /(?:^|[\s(])тв-?(\d+)/i.exec(title) ??
      /\bseason\s*(\d+)/i.exec(title) ??
      /\b(\d+)(?:st|nd|rd|th)\s+season/i.exec(title);
    if (match) return Number(match[1]);
    const numeral = /\s(ii|iii|iv|v|vi)$/i.exec(title.trim());
    if (numeral) return roman[numeral[1].toLowerCase()];
  }
  return null;
}

export interface IdResolverOptions {
  store: Store;
  shikimori: ShikimoriApi | null;
  log: (message: string, error?: unknown) => void;
}

export class IdResolver {
  private options: IdResolverOptions;

  constructor(options: IdResolverOptions) {
    this.options = options;
  }

  /** Дополняет известные ID (например, из Kodik) сохранёнными и найденными на Shikimori. */
  async resolve(release: Release, known: ExternalIds): Promise<ExternalIds> {
    const { store, shikimori } = this.options;
    const ids: ExternalIds = { ...known, shikimori: known.shikimori ?? (release.shikimoriId ? String(release.shikimoriId) : null) };
    if (ids.kinopoisk) {
      store.saveReleaseIds(release.id, ids);
      return ids;
    }

    const saved = store.releaseIds(release.id);
    const withSaved: ExternalIds = {
      ...ids,
      kinopoisk: saved?.kinopoisk ?? null,
      imdb: ids.imdb ?? saved?.imdb ?? null,
      kpSeason: ids.kpSeason ?? saved?.kpSeason ?? null,
    };
    // Найденный ID перепроверяем раз в 30 дней, ненайденный — раз в сутки: у онгоингов
    // ссылка на Кинопоиск появляется не сразу.
    const fresh = saved && Date.now() - Date.parse(saved.checkedAt) < (saved.kinopoisk ? 30 : 1) * DAY;
    if (fresh || !shikimori || !ids.shikimori) return withSaved;

    try {
      const kinopoisk = await shikimori.kinopoiskId(ids.shikimori);
      // Без Kodik сезон на Кинопоиске не узнать — берём его из названия («… 2 сезон»).
      const found: ExternalIds = { ...withSaved, kinopoisk: kinopoisk ?? withSaved.kinopoisk, kpSeason: withSaved.kpSeason ?? seasonFromTitle(release) };
      store.saveReleaseIds(release.id, found);
      return found;
    } catch (error) {
      this.options.log(`Shikimori не ответил для «${release.title}» (в России он заблокирован)`, error);
      return withSaved;
    }
  }
}
