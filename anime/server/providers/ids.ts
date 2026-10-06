// ID тайтла для видеобалансеров. Kodik ищет по Shikimori (он есть в ответе
// AniLiberty), а Alloha, Collaps и другие — по Кинопоиску или IMDb. Такие ID
// берём из ответа Kodik (если есть токен), иначе из GraphQL Shikimori
// (externalLinks → kinopoisk). Найденное храним в базе: Shikimori разрешает
// 5 запросов в секунду и 90 в минуту.

import type { Release } from '../../shared/types.ts';
import type { Store } from '../db.ts';
import type { ExternalIds } from './kodik.ts';

const DAY = 86_400_000;

export class ShikimoriApi {
  private base: string;
  private userAgent: string;

  constructor(base: string, userAgent: string) {
    this.base = base;
    this.userAgent = userAgent;
  }

  /** ID Кинопоиска из внешних ссылок тайтла на Shikimori. */
  async kinopoiskId(shikimoriId: string): Promise<string | null> {
    const response = await fetch(`${this.base}/api/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': this.userAgent },
      body: JSON.stringify({
        query: 'query ($ids: String) { animes(ids: $ids, limit: 1) { id externalLinks { kind url } } }',
        variables: { ids: shikimoriId },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Shikimori ответил ${response.status}`);
    const data = (await response.json()) as { data?: { animes?: { externalLinks?: { kind: string; url: string }[] }[] } };
    for (const link of data.data?.animes?.[0]?.externalLinks ?? []) {
      if (!/^kinopoisk/.test(link.kind)) continue;
      const id = /kinopoisk\.ru\/(?:film|series)\/(\d+)/.exec(link.url)?.[1];
      if (id) return id;
    }
    return null;
  }
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
    if (saved) {
      ids.kinopoisk ??= saved.kinopoisk;
      ids.imdb ??= saved.imdb;
      ids.kpSeason ??= saved.kpSeason;
      // Не нашли раньше — пробуем снова не чаще раза в сутки (у онгоингов ID появляются позже).
      const fresh = Date.now() - Date.parse(saved.checkedAt) < (saved.kinopoisk ? 30 : 1) * DAY;
      if (ids.kinopoisk || fresh) return ids;
    }

    if (shikimori && ids.shikimori) {
      try {
        ids.kinopoisk = await shikimori.kinopoiskId(ids.shikimori);
      } catch (error) {
        this.options.log(`Shikimori не ответил для «${release.title}» (в России он заблокирован)`, error);
        return ids;
      }
    }
    store.saveReleaseIds(release.id, ids);
    return ids;
  }
}
