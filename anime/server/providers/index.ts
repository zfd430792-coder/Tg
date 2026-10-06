// Список плееров для тайтла: наш HLS-плеер AniLibria и встроенные плееры
// видеобалансеров. Каждый балансер — отдельный модуль; если у него нет токена
// или он не ответил, его просто нет в списке.

import type { Dub, PlayerSource, Release } from '../../shared/types.ts';
import { TtlCache } from '../cache.ts';
import type { Store } from '../db.ts';
import { Alloha, type Balancer, Collaps, Lumex } from './balancers.ts';
import { IdResolver, ShikimoriApi } from './ids.ts';
import { type ExternalIds, KodikApi, kodikFallbackLink, kodikPlayer, noIds, toDubs } from './kodik.ts';

export interface PlayersOptions {
  kodikToken: string | null;
  kodikApi: string;
  allohaToken?: string | null;
  allohaApi?: string;
  collapsToken?: string | null;
  collapsApi?: string;
  lumexToken?: string | null;
  lumexApi?: string;
  lumexClientId?: string | null;
  /** Адрес Shikimori для поиска ID Кинопоиска; null — не ходить туда. */
  shikimoriUrl?: string | null;
  userAgent?: string;
  store?: Store;
  log: (message: string, error?: unknown) => void;
}

function anilibriaPlayer(release: Release): PlayerSource | null {
  const playable = release.episodes.filter((e) => e.sources.length > 0);
  if (playable.length === 0) return null;
  return {
    id: 'anilibria',
    title: 'AniLibria',
    kind: 'hls',
    link: null,
    dubs: [],
    frame: null,
    events: null,
    lastEpisode: Math.max(...playable.map((e) => e.ordinal)),
    season: null,
  };
}

const withTimeout = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`нет ответа за ${ms / 1000} с`)), ms).unref())]);

export class Players {
  private cache = new TtlCache(500);
  private kodik: KodikApi | null;
  private balancers: Balancer[];
  private ids: IdResolver | null;
  private log: PlayersOptions['log'];

  constructor(options: PlayersOptions) {
    this.kodik = options.kodikToken ? new KodikApi(options.kodikToken, options.kodikApi) : null;
    this.balancers = [];
    if (options.allohaToken) this.balancers.push(new Alloha(options.allohaToken, options.allohaApi ?? 'https://apbugall.org/v2'));
    if (options.collapsToken) this.balancers.push(new Collaps(options.collapsToken, options.collapsApi ?? 'https://api.bhcesh.me'));
    if (options.lumexToken || options.lumexClientId) {
      this.balancers.push(new Lumex(options.lumexToken ?? null, options.lumexApi ?? 'https://portal.lumex.host/api', options.lumexClientId ?? null));
    }
    this.ids =
      this.balancers.length && options.store
        ? new IdResolver({
            store: options.store,
            shikimori: options.shikimoriUrl ? new ShikimoriApi(options.shikimoriUrl, options.userAgent ?? 'AniMini') : null,
            log: options.log,
          })
        : null;
    this.log = options.log;
  }

  /** Какие балансеры включены (для animini doctor и логов). */
  get enabled(): string[] {
    return ['anilibria', 'kodik', ...this.balancers.map((b) => b.id)];
  }

  forRelease(release: Release): Promise<PlayerSource[]> {
    return this.cache.get(`players:${release.id}`, 20 * 60_000, () => this.collect(release));
  }

  private async collect(release: Release): Promise<PlayerSource[]> {
    const players: PlayerSource[] = [];
    const own = anilibriaPlayer(release);
    if (own) players.push(own);

    let dubs: Dub[] = [];
    let ids: ExternalIds = { ...noIds(), shikimori: release.shikimoriId ? String(release.shikimoriId) : null };
    if (this.kodik) {
      try {
        const found = await withTimeout(this.kodik.translations(release), 12_000);
        dubs = toDubs(found.results);
        ids = { ...ids, ...Object.fromEntries(Object.entries(found.ids).filter(([, v]) => v !== null)) };
      } catch (error) {
        this.log(`Kodik не ответил для «${release.title}»`, error);
      }
    }
    const kodik = kodikPlayer(dubs, kodikFallbackLink(release));
    if (kodik) players.push(kodik);

    if (this.ids && this.balancers.length) {
      ids = await this.ids.resolve(release, ids).catch(() => ids);
      if (ids.kinopoisk || ids.imdb) {
        const found = await Promise.allSettled(this.balancers.map((b) => withTimeout(b.find(release, ids), 10_000)));
        found.forEach((result, i) => {
          if (result.status === 'fulfilled' && result.value) players.push(result.value);
          else if (result.status === 'rejected') this.log(`${this.balancers[i].title} не ответил для «${release.title}»`, result.reason);
        });
      }
    }
    return players;
  }
}
