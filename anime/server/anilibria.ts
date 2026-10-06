// Клиент AniLiberty API (бывший AniLibria): каталог, релизы с сериями в HLS
// 480/720/1080, тайминги опенинга и эндинга, расписание. Документация:
// https://aniliberty.top/api/docs/v1

import type { Episode, Genre, Option, Page, References, Release, ReleaseCard, ScheduleDay, TimeRange, VideoSource } from '../shared/types.ts';
import { TtlCache } from './cache.ts';
import { normalizeLink } from '../shared/players.ts';
import { HostRegistry, absoluteUrl, proxiedUrl } from './media.ts';

// Ответы чужого API разбираем как есть и тут же приводим к своим типам.
type Raw = Record<string, any>;

const QUALITIES = [480, 720, 1080] as const;

const SORT_LABELS: Record<string, string> = {
  FRESH_AT_DESC: 'Недавно обновлённые',
  FRESH_AT_ASC: 'Давно не обновлялись',
  RATING_DESC: 'Самые популярные',
  RATING_ASC: 'Менее популярные',
  YEAR_DESC: 'Сначала новые',
  YEAR_ASC: 'Сначала старые',
};

export class UpstreamError extends Error {
  status: number;

  constructor(status: number, path: string) {
    super(`AniLiberty ответил ${status} на ${path}`);
    this.status = status;
  }
}

export interface CatalogQuery {
  page: number;
  limit: number;
  search?: string;
  genres?: number[];
  types?: string[];
  fromYear?: number;
  toYear?: number;
  sorting?: string;
  ongoing?: boolean;
}

export interface AniLibertyOptions {
  apiBase: string;
  mediaBase: string;
  hlsProxy: boolean;
  hosts: HostRegistry;
  userAgent: string;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function int(value: unknown): number | null {
  const n = Number(value);
  return value !== null && value !== '' && Number.isFinite(n) ? n : null;
}

function list(value: unknown): Raw[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray((value as Raw).data)) return (value as Raw).data;
  return [];
}

function range(value: Raw | null | undefined): TimeRange | null {
  const start = int(value?.start);
  const stop = int(value?.stop);
  return start !== null && stop !== null && stop > start ? { start, stop } : null;
}

function pickImage(image: Raw | null | undefined): unknown {
  return image?.optimized?.preview ?? image?.preview ?? image?.optimized?.src ?? image?.src ?? image?.thumbnail;
}

export class AniLiberty {
  private cache = new TtlCache();
  private options: AniLibertyOptions;
  /** Ссылки на видео по id серии — для мастер-плейлиста без лишнего запроса. */
  private sources = new Map<string, VideoSource[]>();

  constructor(options: AniLibertyOptions) {
    this.options = options;
  }

  private async request(path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
    const response = await fetch(`${this.options.apiBase}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': this.options.userAgent,
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new UpstreamError(response.status, path);
    return response.json();
  }

  private cached<T>(key: string, ttlSec: number, load: () => Promise<T>): Promise<T> {
    return this.cache.get(key, ttlSec * 1000, load);
  }

  card(raw: Raw): ReleaseCard {
    return {
      id: Number(raw.id),
      alias: text(raw.alias) ?? String(raw.id),
      title: text(raw.name?.main) ?? text(raw.name?.english) ?? 'Без названия',
      titleEn: text(raw.name?.english),
      poster: absoluteUrl(pickImage(raw.poster), this.options.mediaBase),
      type: text(raw.type?.description) ?? text(raw.type?.value),
      year: int(raw.year),
      season: text(raw.season?.description),
      ageRating: text(raw.age_rating?.label),
      isOngoing: Boolean(raw.is_ongoing),
      episodesTotal: int(raw.episodes_total),
      publishDay: text(raw.publish_day?.description),
      freshAt: text(raw.fresh_at),
      genres: list(raw.genres)
        .map((g): Genre => ({ id: Number(g.id), name: text(g.name) ?? '' }))
        .filter((g) => Number.isFinite(g.id) && g.name),
    };
  }

  episode(raw: Raw): Episode {
    const sources: VideoSource[] = [];
    for (const quality of QUALITIES) {
      const url = absoluteUrl(raw[`hls_${quality}`], this.options.mediaBase);
      if (!url) continue;
      this.options.hosts.remember(url);
      sources.push({ quality, url: this.options.hlsProxy ? proxiedUrl(url) : url });
    }
    const id = String(raw.id);
    this.sources.delete(id);
    this.sources.set(id, sources);
    if (this.sources.size > 50_000) this.sources.delete(this.sources.keys().next().value as string);
    return {
      id,
      ordinal: int(raw.ordinal) ?? int(raw.sort_order) ?? 0,
      name: text(raw.name),
      preview: absoluteUrl(pickImage(raw.preview), this.options.mediaBase),
      duration: int(raw.duration),
      opening: range(raw.opening),
      ending: range(raw.ending),
      sources,
      master: sources.length > 1 ? `/api/master/${encodeURIComponent(id)}.m3u8` : null,
    };
  }

  release(raw: Raw): Release {
    const voices = list(raw.members)
      .filter((m) => m.role?.value === 'voicing' || /озвуч/i.test(String(m.role?.description ?? '')))
      .map((m) => text(m.nickname))
      .filter((n): n is string => Boolean(n));
    return {
      ...this.card(raw),
      titleAlt: text(raw.name?.alternative),
      description: text(raw.description),
      notification: text(raw.notification),
      averageDuration: int(raw.average_duration_of_episode),
      favorites: int(raw.added_in_users_favorites),
      blocked: Boolean(raw.is_blocked_by_geo || raw.is_blocked_by_copyrights),
      voices: [...new Set(voices)],
      externalPlayer: normalizeLink(text(raw.external_player)),
      episodes: list(raw.episodes)
        .map((e) => this.episode(e))
        .sort((a, b) => a.ordinal - b.ordinal),
    };
  }

  latest(limit = 24): Promise<ReleaseCard[]> {
    return this.cached(`latest:${limit}`, 120, async () =>
      list(await this.request(`/anime/releases/latest?limit=${limit}`)).map((r) => this.card(r)),
    );
  }

  /** Свежие релизы без кэша — для проверки новых серий. */
  async latestFresh(limit = 50): Promise<ReleaseCard[]> {
    return list(await this.request(`/anime/releases/latest?limit=${limit}`)).map((r) => this.card(r));
  }

  random(): Promise<ReleaseCard | null> {
    return this.request('/anime/releases/random?limit=1').then((data) => {
      const first = list(data)[0];
      return first ? this.card(first) : null;
    });
  }

  getRelease(idOrAlias: string, fresh = false): Promise<Release> {
    const key = `release:${idOrAlias}`;
    if (fresh) this.cache.delete(key);
    return this.cached(key, 300, async () =>
      this.release((await this.request(`/anime/releases/${encodeURIComponent(idOrAlias)}`)) as Raw),
    );
  }

  getEpisode(episodeId: string): Promise<Episode> {
    return this.cached(`episode:${episodeId}`, 600, async () =>
      this.episode((await this.request(`/anime/releases/episodes/${encodeURIComponent(episodeId)}`)) as Raw),
    );
  }

  async sourcesFor(episodeId: string): Promise<VideoSource[]> {
    return this.sources.get(episodeId) ?? (await this.getEpisode(episodeId)).sources;
  }

  search(query: string): Promise<ReleaseCard[]> {
    const q = query.trim().slice(0, 100);
    return this.cached(`search:${q.toLowerCase()}`, 300, async () =>
      list(await this.request(`/app/search/releases?query=${encodeURIComponent(q)}`)).map((r) => this.card(r)),
    );
  }

  catalog(query: CatalogQuery): Promise<Page<ReleaseCard>> {
    const f: Raw = {};
    if (query.search) f.search = query.search;
    if (query.genres?.length) f.genres = query.genres;
    if (query.types?.length) f.types = query.types;
    if (query.fromYear || query.toYear) {
      f.years = {};
      if (query.fromYear) f.years.from_year = query.fromYear;
      if (query.toYear) f.years.to_year = query.toYear;
    }
    if (query.sorting) f.sorting = query.sorting;
    if (query.ongoing !== undefined) f.publish_statuses = [query.ongoing ? 'IS_ONGOING' : 'IS_NOT_ONGOING'];
    const body = { page: query.page, limit: query.limit, f };
    return this.cached(`catalog:${JSON.stringify(body)}`, 300, async () => {
      const data = (await this.request('/anime/catalog/releases', { method: 'POST', body })) as Raw;
      const pagination = data?.meta?.pagination ?? {};
      return {
        items: list(data).map((r) => this.card(r)),
        page: int(pagination.current_page) ?? query.page,
        totalPages: int(pagination.total_pages) ?? query.page,
        total: int(pagination.total) ?? 0,
      };
    });
  }

  schedule(): Promise<ScheduleDay[]> {
    return this.cached('schedule', 600, async () => {
      const days = new Map<number, ScheduleDay>();
      for (const item of list(await this.request('/anime/schedule/week'))) {
        const raw = item.release ?? {};
        const day = int(raw.publish_day?.value) ?? 0;
        const entry = days.get(day) ?? { day, title: text(raw.publish_day?.description) ?? 'Без дня', items: [] };
        entry.items.push({
          release: this.card(raw),
          lastEpisode: int(item.published_release_episode?.ordinal),
          nextEpisode: int(item.next_release_episode_number),
        });
        days.set(day, entry);
      }
      return [...days.values()].sort((a, b) => a.day - b.day);
    });
  }

  references(): Promise<References> {
    return this.cached('references', 12 * 3600, async () => {
      const [genres, types, sorting, years] = await Promise.all([
        this.request('/anime/catalog/references/genres'),
        this.request('/anime/catalog/references/types'),
        this.request('/anime/catalog/references/sorting'),
        this.request('/anime/catalog/references/years'),
      ]);
      const options = (data: unknown, labels: Record<string, string> = {}): Option[] =>
        list(data)
          .map((o) => ({ value: String(o.value), label: labels[o.value] ?? text(o.description) ?? text(o.label) ?? String(o.value) }))
          .filter((o) => o.value);
      return {
        genres: list(genres)
          .map((g) => ({ id: Number(g.id), name: text(g.name) ?? '' }))
          .filter((g) => Number.isFinite(g.id) && g.name)
          .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
        types: options(types),
        sorting: options(sorting, SORT_LABELS),
        years: (Array.isArray(years) ? years : []).map(Number).filter(Number.isFinite).sort((a, b) => b - a),
      };
    });
  }
}
