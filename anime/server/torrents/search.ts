// Поиск раздач для тайтла — сервер находит их сам, добавлять руками ничего не нужно:
//   • AniLibria — раздачи самого тайтла из их API (озвучка AniLibria, обычно и японская дорожка);
//   • Jacred (jac.red) и другие сайты с Jackett-совместимым API — раздачи с RuTracker, Rutor,
//     Kinozal, NNM-Club и других трекеров: там озвучки разных студий, BDRip и 4K.
// Из найденного берём то, что подходит тайтлу (название, сезон, год), и лучшие по числу
// раздающих — по паре на каждое качество.

import type { Release } from '../../shared/types.ts';
import { infoHashOf, safeMagnet } from './magnet.ts';
import { heightOf, type JacredInfo, matchTorrent, releaseTarget, searchQueries, type TitleFacts, titleFacts } from './titles.ts';

export interface FoundTorrent {
  source: 'anilibria' | 'jacred';
  /** Откуда раздача: anilibria, rutracker, rutor… */
  tracker: string;
  title: string;
  magnet: string;
  infoHash: string;
  seeders: number;
  size: number | null;
  /** Качество по описанию раздачи (точное узнаем, когда прочитаем саму серию). */
  height: number | null;
  /** Озвучки, если трекер их перечислил. */
  voices: string[];
  facts: TitleFacts | null;
}

export interface Candidate extends FoundTorrent {
  /** Сезон тайтла и сборник ли это сезонов — чтобы из сборника взять папку своего сезона. */
  season: number;
  pack: boolean;
}

export interface SearchReport {
  candidates: Candidate[];
  /** Сколько раздач нашлось всего и сколько подошло тайтлу. */
  found: number;
  matched: number;
  errors: string[];
  /** Источники, которые не ответили: их прежние раздачи не удаляем. */
  failed: FoundTorrent['source'][];
  /** Почему раздачи не подошли — для `animini torrent search`. */
  rejected: { title: string; reason: string }[];
}

export interface TorrentSearchOptions {
  /** Адреса сайтов с Jackett-совместимым API (https://jac.red). */
  jackett: string[];
  apiKey: string;
  userAgent: string;
  /** Раздачи тайтла от самой AniLibria. */
  anilibria: { releaseTorrents(releaseId: number): Promise<unknown[]> } | null;
  fetch?: typeof fetch;
}

type Raw = Record<string, any>;

const MAX_RESPONSE = 15 * 1024 * 1024;
/** Сколько раздач тайтла разбирать: каждую серверу нужно открыть, чтобы узнать озвучки. */
const MAX_CANDIDATES = 8;

function text(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  return null;
}

/** Раздача из ответа Jackett/Jacred (поля Title, MagnetUri, Seeders, Size, Tracker, info). */
export function fromJackett(item: Raw, host: string): FoundTorrent | null {
  const title = text(item?.Title);
  const link = [item?.MagnetUri, item?.Link, item?.Magnet].map(text).find((v) => v?.startsWith('magnet:')) ?? null;
  const infoHash = (link && infoHashOf(link)) ?? (text(item?.InfoHash) ? infoHashOf(text(item.InfoHash)!) : null);
  if (!title || !infoHash) return null;
  const info: JacredInfo | null = item?.info && typeof item.info === 'object' ? item.info : null;
  const voices = Array.isArray((info as Raw | null)?.voices) ? ((info as Raw).voices as unknown[]).map(text).filter((v): v is string => Boolean(v)) : [];
  const facts = titleFacts(title, info);
  return {
    source: 'jacred',
    tracker: text(item?.Tracker) ?? text(item?.TrackerId) ?? host,
    title,
    magnet: safeMagnet(link ?? infoHash)!,
    infoHash,
    seeders: Math.max(0, Number(item?.Seeders) || 0),
    size: Number(item?.Size) > 0 ? Number(item.Size) : null,
    height: facts.height,
    voices,
    facts,
  };
}

/** Раздача из API AniLibria (поля magnet/hash, quality, codec, seeders, size, label). */
export function fromAniLibria(raw: Raw, release: Pick<Release, 'title'>): FoundTorrent | null {
  const link = text(raw?.magnet) ?? text(raw?.hash);
  const infoHash = link ? infoHashOf(link) : null;
  if (!link || !infoHash) return null;
  const quality = text(raw?.quality?.value) ?? text(raw?.quality?.description) ?? text(raw?.quality);
  const codec = text(raw?.codec?.label) ?? text(raw?.codec?.value) ?? text(raw?.codec);
  const label = text(raw?.label) ?? text(raw?.filename);
  const title = label ?? `${release.title} [AniLibria${quality ? ` ${quality}` : ''}${codec ? ` ${codec}` : ''}]`;
  return {
    source: 'anilibria',
    tracker: 'anilibria',
    title,
    magnet: safeMagnet(link)!,
    infoHash,
    seeders: Math.max(0, Number(raw?.seeders) || 0),
    size: Number(raw?.size) > 0 ? Number(raw.size) : null,
    height: heightOf(`${quality ?? ''} ${label ?? ''}`) ?? (Number.parseInt(quality ?? '', 10) || null),
    voices: ['AniLibria'],
    facts: null,
  };
}

function bucket(height: number | null): number {
  if (!height) return 0;
  if (height >= 2000) return 2160;
  if (height >= 1000) return 1080;
  if (height >= 700) return 720;
  return 480;
}

/**
 * Какие раздачи разбирать: у AniLibria — одну, лучшую в 1080p (их озвучка есть и в плеере
 * AniLibria), с трекеров — по две с наибольшим числом раздающих на каждое качество и ещё
 * одну, где больше всего озвучек.
 */
export function pickCandidates(matched: Candidate[], limit = MAX_CANDIDATES): Candidate[] {
  const picked: Candidate[] = [];
  const take = (c: Candidate | undefined) => c && !picked.includes(c) && picked.length < limit && picked.push(c);
  const bySeeders = (a: Candidate, b: Candidate) => b.seeders - a.seeders;

  const own = matched.filter((c) => c.source === 'anilibria').sort(bySeeders);
  take(own.find((c) => bucket(c.height) === 1080) ?? own[0]);

  const other = matched.filter((c) => c.source !== 'anilibria' && c.seeders > 0);
  for (const height of [1080, 2160, 720, 480, 0]) {
    const group = other.filter((c) => bucket(c.height) === height).sort(bySeeders);
    take(group[0]);
    take(group[1]);
    take([...group].sort((a, b) => b.voices.length - a.voices.length || b.seeders - a.seeders)[0]);
  }
  return picked;
}

export class TorrentSearch {
  private options: TorrentSearchOptions;

  constructor(options: TorrentSearchOptions) {
    this.options = options;
  }

  get sources(): string[] {
    return [...(this.options.anilibria ? ['AniLibria'] : []), ...this.options.jackett.map((url) => hostOf(url))];
  }

  /** Раздачи для тайтла: что нашлось, что подошло и какие из них стоит разобрать. */
  async find(release: Release): Promise<SearchReport> {
    const target = releaseTarget(release);
    const errors: string[] = [];
    const failed = new Set<FoundTorrent['source']>();
    const all: FoundTorrent[] = [];
    const tasks: Promise<void>[] = [];
    const { anilibria } = this.options;
    if (anilibria) {
      tasks.push(
        anilibria
          .releaseTorrents(release.id)
          .then((list) => list.forEach((raw) => pushFound(all, fromAniLibria(raw as Raw, release))))
          .catch((error: unknown) => {
            errors.push(`AniLibria: ${messageOf(error)}`);
            failed.add('anilibria');
          }),
      );
    }
    for (const base of this.options.jackett) {
      for (const query of searchQueries(release)) {
        tasks.push(
          this.jackett(base, query)
            .then((list) => list.forEach((item) => pushFound(all, item)))
            .catch((error: unknown) => {
              errors.push(`${hostOf(base)}: ${messageOf(error)}`);
              failed.add('jacred');
            }),
        );
      }
    }
    await Promise.all(tasks);

    // Одна раздача бывает и у AniLibria, и на трекере (Jacred собирает и их трекер) — берём одну.
    const unique = new Map<string, FoundTorrent>();
    for (const item of all) {
      const seen = unique.get(item.infoHash);
      if (!seen || (seen.source !== 'anilibria' && item.source === 'anilibria')) unique.set(item.infoHash, item);
    }
    const matched: Candidate[] = [];
    const rejected: SearchReport['rejected'] = [];
    for (const item of unique.values()) {
      if (item.source === 'anilibria') {
        matched.push({ ...item, season: target.season, pack: false });
        continue;
      }
      const match = matchTorrent(target, item.facts!);
      if (match.ok) matched.push({ ...item, season: target.season, pack: match.pack });
      else rejected.push({ title: item.title, reason: match.reason ?? 'не подходит' });
    }
    return { candidates: pickCandidates(matched), found: unique.size, matched: matched.length, errors: [...new Set(errors)], failed: [...failed], rejected };
  }

  private async jackett(base: string, query: string): Promise<FoundTorrent[]> {
    const url = `${base}/api/v2.0/indexers/all/results?apikey=${encodeURIComponent(this.options.apiKey)}&Query=${encodeURIComponent(query)}`;
    const response = await (this.options.fetch ?? fetch)(url, {
      headers: { accept: 'application/json', 'user-agent': this.options.userAgent },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`ответ ${response.status}`);
    const body = await response.text();
    if (body.length > MAX_RESPONSE) throw new Error('слишком большой ответ');
    const data = JSON.parse(body) as Raw;
    const results: unknown[] = Array.isArray(data?.Results) ? data.Results : Array.isArray(data) ? data : [];
    return results.map((item) => fromJackett(item as Raw, hostOf(base))).filter((item): item is FoundTorrent => item !== null);
  }
}

function pushFound(all: FoundTorrent[], item: FoundTorrent | null): void {
  if (item) all.push(item);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.name === 'TimeoutError' ? 'не ответил за 30 секунд' : error.message;
  return String(error);
}
