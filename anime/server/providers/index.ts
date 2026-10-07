// Список плееров для тайтла: наш HLS-плеер AniLibria и встроенные плееры
// видеобалансеров: Kodik, CVH и Alloha. Kodik есть всегда (без токена — общий плеер
// с выбором озвучки внутри), CVH и Alloha — только с их партнёрским ID или токеном.

import type { Dub, PlayerSource, Release } from '../../shared/types.ts';
import { TtlCache } from '../cache.ts';
import type { Store } from '../db.ts';
import { Alloha, type Balancer, Cvh } from './balancers.ts';
import { IdResolver, ShikimoriApi } from './ids.ts';
import { type ExternalIds, idsFrom, KodikApi, kodikFallbackLink, kodikPlayer, noIds, toDubs } from './kodik.ts';

export interface PlayersOptions {
  kodikToken: string | null;
  kodikApi: string;
  cvhPublisherId?: string | null;
  cvhApi?: string;
  allohaToken?: string | null;
  allohaApi?: string;
  /** Поддомен для плеера CVH (https://player.example.com); без него CVH выключен. */
  playerUrl?: string | null;
  /** Адрес Shikimori для поиска ID Кинопоиска (нужен Alloha); null — не ходить туда. */
  shikimoriUrl?: string | null;
  userAgent?: string;
  store?: Store;
  /** Плеер из торрент-раздач (если торрент-плеер включён); search — поискать раздачи, если давно не искали. */
  torrents?: { players(release: Release, options?: { search?: boolean }): PlayerSource[] } | null;
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
  private torrents: PlayersOptions['torrents'];
  private log: PlayersOptions['log'];

  constructor(options: PlayersOptions) {
    this.torrents = options.torrents ?? null;
    this.kodik = options.kodikToken ? new KodikApi(options.kodikToken, options.kodikApi) : null;
    this.balancers = [];
    if (options.cvhPublisherId && options.playerUrl) {
      this.balancers.push(new Cvh(options.cvhPublisherId, options.cvhApi ?? 'https://plapi.cdnvideohub.com/api/v1', options.playerUrl));
    }
    if (options.allohaToken) this.balancers.push(new Alloha(options.allohaToken, options.allohaApi ?? 'https://api.alloha.tv'));
    // ID Кинопоиска ищем, только если он кому-то нужен (Alloha; без него она ищет по названию).
    this.ids =
      options.allohaToken && options.store
        ? new IdResolver({
            store: options.store,
            shikimori: options.shikimoriUrl ? new ShikimoriApi(options.shikimoriUrl, options.userAgent ?? 'AniMini') : null,
            log: options.log,
          })
        : null;
    this.log = options.log;
  }

  /** Какие плееры включены (для лога при запуске). */
  get enabled(): string[] {
    return [
      'anilibria',
      ...(this.torrents ? ['torrent'] : []),
      this.kodik ? 'kodik (озвучки по токену)' : 'kodik (общий плеер)',
      ...this.balancers.map((b) => b.id),
    ];
  }

  /**
   * Плееры тайтла. Свой плеер считаем на каждый запрос из свежих данных релиза (вышла
   * первая серия — он сразу появится), а балансеры кэшируем на 20 минут. Если кто-то из
   * них не ответил, неполный список держим всего минуту.
   */
  async forRelease(release: Release, options: { searchTorrents?: boolean } = {}): Promise<PlayerSource[]> {
    const key = `players:${release.id}`;
    const { players, degraded } = await this.cache.get(key, 20 * 60_000, () => this.collect(release));
    if (degraded) this.cache.shorten(key, 60_000);
    // Свой плеер и торрент-раздачи — из свежих данных, без кэша: раздачу могли только что добавить.
    const own = anilibriaPlayer(release);
    const torrents = this.torrents?.players(release, { search: options.searchTorrents }) ?? [];
    return [...(own ? [own] : []), ...torrents, ...players];
  }

  private async collect(release: Release): Promise<{ players: PlayerSource[]; degraded: boolean }> {
    const players: PlayerSource[] = [];
    let degraded = false;

    let dubs: Dub[] = [];
    const shikimori = release.shikimoriId ? String(release.shikimoriId) : null;
    let ids: ExternalIds = { ...noIds(), shikimori };
    if (this.kodik) {
      try {
        const results = await withTimeout(this.kodik.translations(release), 12_000);
        dubs = toDubs(results);
        ids = idsFrom(results, shikimori);
      } catch (error) {
        degraded = true;
        this.log(`Kodik не ответил для «${release.title}»`, error);
      }
    }
    const kodik = kodikPlayer(dubs, kodikFallbackLink(release));
    if (kodik) players.push(kodik);

    if (this.balancers.length) {
      if (this.ids) {
        ids = await this.ids.resolve(release, ids).catch((error: unknown) => {
          degraded = true;
          this.log(`Не удалось найти ID Кинопоиска для «${release.title}»`, error);
          return ids;
        });
      }
      // CVH ищет аниме по ID Shikimori, Alloha — по Кинопоиску или IMDb, а без них — по названию.
      const found = await Promise.allSettled(this.balancers.map((b) => withTimeout(b.find(release, ids), 15_000)));
      found.forEach((result, i) => {
        if (result.status === 'fulfilled' && result.value) players.push(result.value);
        if (result.status === 'rejected') {
          degraded = true;
          this.log(`${this.balancers[i].title} не ответил для «${release.title}»`, result.reason);
        }
      });
    }
    return { players, degraded };
  }
}
