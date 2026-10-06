// Список плееров для тайтла: наш HLS-плеер AniLibria и встроенный плеер Kodik.
// С токеном Kodik у каждой озвучки своя ссылка и кнопка на нашей странице, без
// него — общий плеер Kodik, где озвучку выбирают внутри.

import type { Dub, PlayerSource, Release } from '../../shared/types.ts';
import { TtlCache } from '../cache.ts';
import { KodikApi, kodikFallbackLink, kodikPlayer, toDubs } from './kodik.ts';

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
  private log: PlayersOptions['log'];

  constructor(options: PlayersOptions) {
    this.kodik = options.kodikToken ? new KodikApi(options.kodikToken, options.kodikApi) : null;
    this.log = options.log;
  }

  /** Какие плееры включены (для лога при запуске). */
  get enabled(): string[] {
    return ['anilibria', this.kodik ? 'kodik (озвучки по токену)' : 'kodik (общий плеер)'];
  }

  /**
   * Плееры тайтла. Свой плеер считаем на каждый запрос из свежих данных релиза (вышла
   * первая серия — он сразу появится), а ответ Kodik кэшируем на 20 минут. Если Kodik
   * не ответил, общий плеер без списка озвучек держим всего минуту.
   */
  async forRelease(release: Release): Promise<PlayerSource[]> {
    const key = `players:${release.id}`;
    const { players, degraded } = await this.cache.get(key, 20 * 60_000, () => this.collect(release));
    if (degraded) this.cache.shorten(key, 60_000);
    const own = anilibriaPlayer(release);
    return own ? [own, ...players] : players;
  }

  private async collect(release: Release): Promise<{ players: PlayerSource[]; degraded: boolean }> {
    let dubs: Dub[] = [];
    let degraded = false;
    if (this.kodik) {
      try {
        dubs = toDubs(await withTimeout(this.kodik.translations(release), 12_000));
      } catch (error) {
        degraded = true;
        this.log(`Kodik не ответил для «${release.title}»`, error);
      }
    }
    const kodik = kodikPlayer(dubs, kodikFallbackLink(release));
    return { players: kodik ? [kodik] : [], degraded };
  }
}
