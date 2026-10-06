// Видеобалансеры, которые ищут тайтл по ID Кинопоиска или IMDb: Alloha, Collaps,
// Lumex. Аниме у них меньше, чем у Kodik, зато бывают другие озвучки и качество.
// У Кинопоиска один ID на весь сериал, поэтому нужен ещё номер сезона (kpSeason).
//
// Форматы API собраны по открытым клиентам этих балансеров (см. README):
//   Alloha  GET https://apbugall.org/v2/movies/search?kp=ID, Authorization: Bearer
//   Collaps GET https://api.bhcesh.me/franchise/details?token=T&kinopoisk_id=ID
//   Lumex   GET https://portal.lumex.host/api/short?api_token=T&kinopoisk_id=ID

import { normalizeLink } from '../../shared/players.ts';
import type { Dub, PlayerSource, Release } from '../../shared/types.ts';
import type { ExternalIds } from './kodik.ts';

type Raw = Record<string, any>;

export interface Balancer {
  id: string;
  title: string;
  find(release: Release, ids: ExternalIds): Promise<PlayerSource | null>;
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<Raw> {
  const response = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  try {
    return JSON.parse(text) as Raw;
  } catch {
    throw new Error(`${new URL(url).hostname} ответил ${response.status}`);
  }
}

const values = (value: unknown): Raw[] =>
  Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value as Raw) : [];

const toNumber = (value: unknown): number | null => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function withParam(link: string, key: string, value: string): string {
  const url = new URL(link);
  url.searchParams.set(key, value);
  return url.toString();
}

/**
 * Какой сезон открывать. Сериал на Кинопоиске один на все сезоны, а наш тайтл — один
 * сезон. Если сезонов несколько и какой из них наш, неизвестно, — серию выбирают в плеере.
 */
function pickSeason(seasons: Raw[], kpSeason: number | null): number | null {
  const numbers = seasons.map((s) => toNumber(s.season)).filter((n): n is number => n !== null);
  if (kpSeason && numbers.includes(kpSeason)) return kpSeason;
  return numbers.length === 1 ? numbers[0] : null;
}

/** Параметры для открытия серии: фильм — без них, сериал — только когда сезон известен. */
function episodeParams(seasons: Raw[], season: number | null) {
  if (seasons.length === 0) return { season: null, episode: null };
  return season ? { season: 'season', episode: 'episode' } : { season: null, episode: null };
}

function lastEpisodeIn(season: Raw | undefined): number | null {
  if (!season) return null;
  const numbers = values(season.episodes)
    .map((e) => toNumber(e.episode))
    .filter((n): n is number => n !== null);
  return numbers.length ? Math.max(...numbers) : toNumber(season.episodes_count);
}

const isSubtitles = (name: string) => /субт|subs?\b/i.test(name);

export class Alloha implements Balancer {
  id = 'alloha';
  title = 'Alloha';
  private token: string;
  private base: string;

  constructor(token: string, base: string) {
    this.token = token;
    this.base = base;
  }

  async find(_release: Release, ids: ExternalIds): Promise<PlayerSource | null> {
    const query = ids.kinopoisk ? `kp=${ids.kinopoisk}` : ids.imdb ? `imdb=${ids.imdb}` : null;
    if (!query) return null;
    const answer = await getJson(`${this.base}/movies/search?${query}`, { authorization: `Bearer ${this.token}` });
    if (answer.status === 'error' || answer.error) return null;
    const data = answer.data ?? {};
    const iframe = normalizeLink(data.iframe ?? data.iframe_url);
    if (!iframe) return null;

    const seasons = values(data.seasons);
    const season = pickSeason(seasons, ids.kpSeason);
    const current = seasons.find((s) => toNumber(s.season) === season);

    // Последняя серия каждой озвучки в нашем сезоне.
    const lastByDub = new Map<string, number>();
    for (const episode of values(current?.episodes)) {
      const number = toNumber(episode.episode);
      if (!number) continue;
      const dubs = Array.isArray(episode.translations)
        ? episode.translations.map((t: Raw) => String(t.id))
        : Object.keys(episode.translation ?? episode.translations ?? {});
      for (const id of dubs) lastByDub.set(id, Math.max(lastByDub.get(id) ?? 0, number));
    }

    const translations: { id: string; name: string }[] = Array.isArray(data.translations)
      ? data.translations.map((t: Raw) => ({ id: String(t.id), name: String(t.name ?? '') }))
      : Object.entries(data.translation_iframe ?? {}).map(([id, t]) => ({ id, name: String((t as Raw).name ?? '') }));
    const seasonKey = season ? String(season) : null;
    const dubs: Dub[] = translations
      .filter((t) => t.id && t.name)
      .map((t) => ({
        id: `alloha:${t.id}`,
        title: t.name,
        type: isSubtitles(t.name) ? 'subtitles' : 'voice',
        link: withParam(iframe, 'translation', t.id),
        lastEpisode: seasons.length ? (lastByDub.get(t.id) ?? lastEpisodeIn(current)) : 1,
        season: seasonKey,
      }));
    dubs.sort((a, b) => Number(a.type === 'subtitles') - Number(b.type === 'subtitles') || (b.lastEpisode ?? 0) - (a.lastEpisode ?? 0));

    return {
      id: this.id,
      title: this.title,
      kind: 'iframe',
      link: iframe,
      dubs,
      frame: { ...episodeParams(seasons, season), hideDubs: { hidden: 'translation' }, showDubs: ['hidden'] },
      events: null,
      lastEpisode: seasons.length ? lastEpisodeIn(current) : 1,
      season: seasonKey,
    };
  }
}

export class Collaps implements Balancer {
  id = 'collaps';
  title = 'Collaps';
  private token: string;
  private base: string;

  constructor(token: string, base: string) {
    this.token = token;
    this.base = base;
  }

  async find(_release: Release, ids: ExternalIds): Promise<PlayerSource | null> {
    const query = ids.kinopoisk ? `kinopoisk_id=${ids.kinopoisk}` : ids.imdb ? `imdb_id=${ids.imdb.replace(/^tt/, '')}` : null;
    if (!query) return null;
    const data = await getJson(`${this.base}/franchise/details?token=${encodeURIComponent(this.token)}&${query}`);
    const iframe = normalizeLink(data.iframe_url);
    if (!iframe || data.error) return null;
    const seasons = values(data.seasons);
    const season = pickSeason(seasons, ids.kpSeason);
    const current = seasons.find((s) => toNumber(s.season) === season);
    // Озвучки у Collaps — звуковые дорожки одного видео: выбирают их внутри плеера.
    return {
      id: this.id,
      title: this.title,
      kind: 'iframe',
      link: iframe,
      dubs: [],
      frame: { ...episodeParams(seasons, season), hideDubs: null, showDubs: [] },
      events: null,
      lastEpisode: seasons.length ? lastEpisodeIn(current) : 1,
      season: season ? String(season) : null,
    };
  }
}

export class Lumex implements Balancer {
  id = 'lumex';
  title = 'Lumex';
  private token: string | null;
  private base: string;
  private clientId: string | null;

  constructor(token: string | null, base: string, clientId: string | null) {
    this.token = token;
    this.base = base;
    this.clientId = clientId;
  }

  async find(_release: Release, ids: ExternalIds): Promise<PlayerSource | null> {
    let iframe: string | null = null;
    if (this.token) {
      const query = ids.kinopoisk ? `kinopoisk_id=${ids.kinopoisk}` : ids.imdb ? `imdb_id=${ids.imdb}` : null;
      if (!query) return null;
      const data = await getJson(`${this.base}/short?api_token=${encodeURIComponent(this.token)}&${query}`);
      iframe = normalizeLink(values(data.data)[0]?.iframe_src);
    } else if (this.clientId && ids.kinopoisk) {
      // Прямая ссылка на плеер по публичному ID сайта: без запроса к API.
      iframe = `https://p.lumex.space/${encodeURIComponent(this.clientId)}?kp_id=${ids.kinopoisk}`;
    }
    if (!iframe) return null;
    // Параметры серии у плеера Lumex не подтверждены — сезон, серию и озвучку выбирают в нём.
    return {
      id: this.id,
      title: this.title,
      kind: 'iframe',
      link: iframe,
      dubs: [],
      frame: { season: null, episode: null, hideDubs: null, showDubs: [] },
      events: null,
      lastEpisode: null,
      season: null,
    };
  }
}
