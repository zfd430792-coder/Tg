// Kodik — видеобалансер с озвучками почти всех студий. С токеном партнёра его
// API отдаёт по тайтлу список переводов, у каждого своя ссылка на плеер. Без
// токена остаётся ссылка на плеер, которую даёт сам AniLiberty (external_player):
// там озвучку выбирают внутри плеера.
//
// Формат API: POST https://kodik-api.com/search, параметры формой, ошибки —
// {"error": "..."}; одна запись на каждый перевод.

import { normalizeLink } from '../../shared/players.ts';
import type { Dub, PlayerSource, Release } from '../../shared/types.ts';

type Raw = Record<string, any>;

export interface KodikResult {
  id: string;
  type: string;
  link: string;
  title: string;
  title_orig?: string;
  other_title?: string;
  year?: number;
  translation?: { id: number; title: string; type: string };
  last_season?: number;
  last_episode?: number;
  episodes_count?: number;
  shikimori_id?: string;
  kinopoisk_id?: string;
  imdb_id?: string;
  seasons?: Record<string, unknown>;
}

export interface ExternalIds {
  shikimori: string | null;
  kinopoisk: string | null;
  imdb: string | null;
}

export class KodikError extends Error {}

/** Ключ для поиска по ссылке: без схемы и параметров, как ждёт player_link. */
export function playerLinkKey(link: string): string {
  return link.replace(/^(https?:)?\/\//i, '').replace(/[?#].*$/, '');
}

const normalizeTitle = (value: string | undefined | null) =>
  (value ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export class KodikApi {
  private token: string;
  private base: string;

  constructor(token: string, base: string) {
    this.token = token;
    this.base = base;
  }

  async search(params: Record<string, string>): Promise<KodikResult[]> {
    const response = await fetch(`${this.base}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ token: this.token, ...params }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    let data: Raw;
    try {
      data = JSON.parse(text);
    } catch {
      throw new KodikError(`Kodik ответил ${response.status}`);
    }
    if (typeof data?.error === 'string') throw new KodikError(`Kodik: ${data.error}`);
    return Array.isArray(data?.results) ? (data.results as KodikResult[]) : [];
  }

  /** Находит запись тайтла: по ссылке из AniLiberty, иначе по названию и году. */
  async find(release: Release): Promise<KodikResult | null> {
    if (release.externalPlayer) {
      const [byLink] = await this.search({ player_link: playerLinkKey(release.externalPlayer), limit: '5' });
      if (byLink) return byLink;
    }
    const wanted = [release.title, release.titleEn].map(normalizeTitle).filter(Boolean);
    const found = await this.search({ title: release.title, types: 'anime-serial,anime', limit: '50' });
    const matches = found.filter((r) => {
      const names = [r.title, r.title_orig, ...(r.other_title ?? '').split('/')].map(normalizeTitle);
      return names.some((n) => wanted.includes(n));
    });
    const sameYear = matches.filter((r) => !release.year || !r.year || Math.abs(r.year - release.year) <= 1);
    return sameYear[0] ?? matches[0] ?? null;
  }

  /** Все переводы тайтла. Группируем по shikimori_id: kinopoisk_id бывает общий у разных сезонов. */
  async translations(release: Release): Promise<{ results: KodikResult[]; ids: ExternalIds }> {
    const base = await this.find(release);
    if (!base) return { results: [], ids: { shikimori: null, kinopoisk: null, imdb: null } };
    const ids: ExternalIds = {
      shikimori: base.shikimori_id ? String(base.shikimori_id) : null,
      kinopoisk: base.kinopoisk_id ? String(base.kinopoisk_id) : null,
      imdb: base.imdb_id ? String(base.imdb_id) : null,
    };
    const results = ids.shikimori ? await this.search({ shikimori_id: ids.shikimori, limit: '100' }) : [base];
    return { results: results.length ? results : [base], ids };
  }
}

function lastEpisodeOf(result: KodikResult): number | null {
  const value = Number(result.last_episode ?? result.episodes_count);
  if (Number.isFinite(value) && value > 0) return value;
  return result.type === 'anime' || result.type?.endsWith('movie') ? 1 : null;
}

function seasonOf(result: KodikResult): string | null {
  if (result.last_season !== undefined && result.last_season !== null) return String(result.last_season);
  const keys = Object.keys(result.seasons ?? {});
  return keys.length ? keys[keys.length - 1] : null;
}

/** Переводы → озвучки: по одной на перевод, сначала озвучки, потом субтитры, больше серий — выше. */
export function toDubs(results: KodikResult[]): Dub[] {
  const byTranslation = new Map<number, Dub>();
  for (const result of results) {
    const link = normalizeLink(result.link);
    const translation = result.translation;
    if (!link || !translation || typeof translation.id !== 'number') continue;
    const dub: Dub = {
      id: `kodik:${translation.id}`,
      title: String(translation.title ?? 'Без названия').trim(),
      type: translation.type === 'voice' || translation.type === 'subtitles' ? translation.type : null,
      link,
      lastEpisode: lastEpisodeOf(result),
      season: seasonOf(result),
    };
    const previous = byTranslation.get(translation.id);
    if (!previous || (dub.lastEpisode ?? 0) > (previous.lastEpisode ?? 0)) byTranslation.set(translation.id, dub);
  }
  return [...byTranslation.values()].sort(
    (a, b) =>
      Number(a.type === 'subtitles') - Number(b.type === 'subtitles') ||
      (b.lastEpisode ?? 0) - (a.lastEpisode ?? 0) ||
      a.title.localeCompare(b.title, 'ru'),
  );
}

const KODIK_EPISODES = { season: 'season', episode: 'episode' };

/** Плеер Kodik для тайтла: со списком озвучек (токен) или общий, с выбором внутри. */
export function kodikPlayer(dubs: Dub[], fallbackLink: string | null): PlayerSource | null {
  if (dubs.length) {
    return {
      id: 'kodik',
      title: 'Kodik',
      kind: 'iframe',
      link: null,
      dubs,
      episodeParams: KODIK_EPISODES,
      lastEpisode: Math.max(...dubs.map((d) => d.lastEpisode ?? 0)) || null,
      season: null,
    };
  }
  if (!fallbackLink) return null;
  return {
    id: 'kodik',
    title: 'Kodik',
    kind: 'iframe',
    link: fallbackLink,
    dubs: [],
    // Сезон неизвестен: без токена открываем серию только номером, а дальше выбирают в плеере.
    episodeParams: { season: null, episode: 'episode' },
    lastEpisode: null,
    season: null,
  };
}
