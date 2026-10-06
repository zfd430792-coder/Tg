// Список плееров для тайтла: наш HLS-плеер AniLibria и встроенные плееры
// видеобалансеров. Каждый балансер — отдельный модуль; если у него нет токена
// или он не ответил, его просто нет в списке.

import type { Dub, PlayerSource, Release } from '../../shared/types.ts';
import { TtlCache } from '../cache.ts';
import { type ExternalIds, KodikApi, kodikPlayer, toDubs } from './kodik.ts';

export interface PlayersOptions {
  kodikToken: string | null;
  kodikApi: string;
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
    episodeParams: null,
    lastEpisode: Math.max(...playable.map((e) => e.ordinal)),
    season: null,
  };
}

export class Players {
  private cache = new TtlCache(500);
  private kodik: KodikApi | null;
  private log: PlayersOptions['log'];

  constructor(options: PlayersOptions) {
    this.kodik = options.kodikToken ? new KodikApi(options.kodikToken, options.kodikApi) : null;
    this.log = options.log;
  }

  forRelease(release: Release): Promise<PlayerSource[]> {
    return this.cache.get(`players:${release.id}`, 20 * 60_000, () => this.collect(release));
  }

  private async collect(release: Release): Promise<PlayerSource[]> {
    const players: PlayerSource[] = [];
    const own = anilibriaPlayer(release);
    if (own) players.push(own);

    let dubs: Dub[] = [];
    let ids: ExternalIds = { shikimori: null, kinopoisk: null, imdb: null };
    if (this.kodik) {
      try {
        const found = await this.kodik.translations(release);
        dubs = toDubs(found.results);
        ids = found.ids;
      } catch (error) {
        this.log(`Kodik не ответил для «${release.title}»`, error);
      }
    }
    const kodik = kodikPlayer(dubs, release.externalPlayer);
    if (kodik) players.push(kodik);
    void ids; // понадобятся остальным балансерам: они ищут по ID Кинопоиска и Shikimori
    return players;
  }
}
