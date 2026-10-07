// Поиск раздач для тайтла — сервер находит их сам, добавлять руками ничего не нужно:
//   • AniLibria — раздачи самого тайтла из их API (озвучка AniLibria, обычно и японская дорожка);
//   • Jacred (jac.red) и другие сайты с Jackett-совместимым API — раздачи с RuTracker, Rutor,
//     Kinozal, NNM-Club и других трекеров: там озвучки разных студий, BDRip и 4K.
// Из найденного берём то, что подходит тайтлу (название, сезон, год), и лучшие по числу
// раздающих — по паре на каждое качество.

import type { Release } from '../../shared/types.ts';
import type { FoundTorrentInput } from '../db.ts';
import { infoHashOf, OPEN_TRACKERS, safeMagnet } from './magnet.ts';
import { studioOrder, studiosIn } from './studios.ts';
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
  /** Известные студии в раздаче (по списку озвучек и названию): Dream Cast, AniDub… */
  studios: string[];
  facts: TitleFacts | null;
}

export interface Candidate extends FoundTorrent {
  /** Сезон тайтла и сборник ли это сезонов — чтобы из сборника взять папку своего сезона. */
  season: number;
  pack: boolean;
  /** Серий в тайтле и последний ли это сезон сборника: в сборнике без папок по ним считаем номера. */
  episodes: number | null;
  lastSeason: boolean;
}

export interface SearchReport {
  candidates: Candidate[];
  /** Все подошедшие тайтлу, в том числе не выбранные. */
  matchedList: Candidate[];
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
  /** Пауза между запросами к одному сайту, мс: на два запроса сразу jac.red отвечает 429. */
  interval?: number;
  /** Сколько ждать перед повтором после 429, если сайт не сказал сам, мс (умножается на номер попытки). */
  retryDelay?: number;
}

/** Когда к сайту поиска можно обратиться снова (общая очередь на процесс). */
const nextRequest = new Map<string, number>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Раздачи, которые не нужны даже с подходящим названием: украинская озвучка, raw без перевода. */
export function skipReason(item: Pick<FoundTorrent, 'title' | 'tracker'>): string | null {
  const name = item.title.split(/\s\/\s|\[/)[0];
  if (/[іїєґ]/i.test(name) || /^(toloka|mazepa)(,|$)/i.test(item.tracker.trim())) return 'украинская раздача';
  if (/(?<![a-z])raw(?![a-z])/i.test(item.title)) return 'без перевода (raw)';
  return null;
}

type Raw = Record<string, any>;

const MAX_RESPONSE = 15 * 1024 * 1024;
/** Сколько раздач тайтла разбирать: каждую серверу нужно открыть, чтобы узнать озвучки. */
const MAX_CANDIDATES = 10;
/** Трекер RuTracker для magnet-ссылок (без passkey): с ним раздающие находятся быстрее, чем только через DHT. */
const RUTRACKER_TRACKERS = ['http://bt.t-ru.org/ann?magnet', 'http://bt2.t-ru.org/ann?magnet', 'http://bt3.t-ru.org/ann?magnet', 'http://bt4.t-ru.org/ann?magnet'];

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
  const tracker = text(item?.Tracker) ?? text(item?.TrackerId) ?? host;
  const trackers = /rutracker/i.test(tracker) ? [...RUTRACKER_TRACKERS, ...OPEN_TRACKERS] : OPEN_TRACKERS;
  return {
    source: 'jacred',
    tracker,
    title,
    magnet: safeMagnet(link ?? infoHash, trackers)!,
    infoHash,
    seeders: Math.max(0, Number(item?.Seeders) || 0),
    size: Number(item?.Size) > 0 ? Number(item.Size) : null,
    height: facts.height,
    voices,
    // Rutor пишет озвучки в названии: «… | AniLibria, AniDub, Dream Cast».
    studios: studiosIn([...voices, ...title.split(/\s\|\s/).slice(1)]),
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
    studios: ['AniLibria'],
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

/** Сколько озвучек, похоже, в раздаче: перечисленные трекером, а «RUS(ext)» на RuTracker — обычно несколько. */
function dubsGuess(c: Candidate): number {
  if (c.voices.length) return c.voices.length;
  if (/rus\s*\(ext\)/i.test(c.title)) return 3;
  return /rus\s*\(int\)/i.test(c.title) ? 1 : 0;
}

/**
 * Какие раздачи разбирать (каждую сервер открывает, чтобы узнать озвучки):
 *   1. у AniLibria — одну, лучшую в 1080p (их озвучка есть и в плеере AniLibria);
 *   2. раздачи с популярными студиями (Dream Cast, AniDub, Studio Band…), которых ещё нет
 *      в выбранных, — сначала самые популярные студии, из раздач — в 1080p и живее;
 *   3. по две самых живых на каждое качество и ещё одну, где больше всего озвучек.
 */
export function pickCandidates(matched: Candidate[], limit = MAX_CANDIDATES): Candidate[] {
  const picked: Candidate[] = [];
  const take = (c: Candidate | undefined) => c && !picked.includes(c) && picked.length < limit && picked.push(c);
  const bySeeders = (a: Candidate, b: Candidate) => b.seeders - a.seeders;

  // У AniLibria — 1080p в H.264, если есть: его покажет любой браузер, HEVC — не любой.
  const own = matched.filter((c) => c.source === 'anilibria').sort(bySeeders);
  const hevc = (c: Candidate) => /hevc|x265|h\.?265/i.test(c.title);
  take(own.find((c) => bucket(c.height) === 1080 && !hevc(c)) ?? own.find((c) => bucket(c.height) === 1080) ?? own[0]);

  const other = matched.filter((c) => c.source !== 'anilibria' && c.seeders > 0);
  const covered = new Set(picked.flatMap((c) => c.studios));
  const quality = (c: Candidate) => ({ 1080: 3, 2160: 2, 720: 2, 480: 1, 0: 1 })[bucket(c.height)] ?? 1;
  // Оставляем пару мест на разные качества.
  while (picked.length < limit - 2) {
    let best: Candidate | null = null;
    let bestScore = 0;
    for (const c of other) {
      if (picked.includes(c)) continue;
      const fresh = c.studios.filter((studio) => !covered.has(studio));
      if (fresh.length === 0) continue;
      const score = fresh.reduce((sum, studio) => sum + (100 - studioOrder(studio)), 0) * 1000 + quality(c) * 100 + Math.min(c.seeders, 99);
      if (score > bestScore) [best, bestScore] = [c, score];
    }
    if (!best) break;
    take(best);
    best.studios.forEach((studio) => covered.add(studio));
  }

  // На каждое качество — хотя бы по две (самые живые).
  for (const height of [1080, 2160, 720, 480, 0]) {
    const fresh = other.filter((c) => bucket(c.height) === height && !picked.includes(c)).sort(bySeeders);
    while (picked.filter((c) => bucket(c.height) === height).length < 2 && fresh.length) take(fresh.shift());
  }
  // Остальные места — раздачам, где, похоже, больше озвучек (их видно, только когда раздачу откроешь).
  // С одним раздающим раздача чаще всего не откроется — такие только ради редкой студии (выше).
  const rest = other
    .filter((c) => !picked.includes(c) && c.seeders > 1)
    .sort((a, b) => dubsGuess(b) - dubsGuess(a) || quality(b) - quality(a) || b.seeders - a.seeders);
  rest.forEach((c) => take(c));
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
    const { anilibria } = this.options;
    const own = anilibria
      ? anilibria
          .releaseTorrents(release.id)
          .then((list) => list.forEach((raw) => pushFound(all, fromAniLibria(raw as Raw, release))))
          .catch((error: unknown) => {
            errors.push(`AniLibria: ${messageOf(error)}`);
            failed.add('anilibria');
          })
      : Promise.resolve();
    // К трекерам — по одному запросу (на два сразу jac.red отвечает 429). Название в оригинале
    // спрашиваем, только если по-русски подходящего нашлось мало (русские названия бывают разными).
    const trackers = (async () => {
      for (const base of this.options.jackett) {
        for (const [i, query] of searchQueries(release).entries()) {
          const enough = all.filter((item) => item.source === 'jacred' && !skipReason(item) && matchTorrent(target, item.facts!).ok).length >= 3;
          if (i > 0 && enough) break;
          try {
            (await this.jackett(base, query)).forEach((item) => all.push(item));
          } catch (error) {
            errors.push(`${hostOf(base)}: ${messageOf(error)}`);
            failed.add('jacred');
          }
        }
      }
    })();
    await Promise.all([own, trackers]);

    // Одна раздача бывает и у AniLibria, и на трекере (Jacred собирает и их трекер) — берём одну.
    const unique = new Map<string, FoundTorrent>();
    for (const item of all) {
      const seen = unique.get(item.infoHash);
      if (!seen || (seen.source !== 'anilibria' && item.source === 'anilibria')) unique.set(item.infoHash, item);
    }
    const matched: Candidate[] = [];
    const rejected: SearchReport['rejected'] = [];
    const last = (seasons: number[]) => seasons.length === 0 || Math.max(...seasons) === target.season;
    for (const item of unique.values()) {
      const base = { season: target.season, episodes: target.episodesTotal };
      if (item.source === 'anilibria') {
        matched.push({ ...item, ...base, pack: false, lastSeason: true });
        continue;
      }
      const skip = skipReason(item);
      const match = skip ? { ok: false, pack: false, reason: skip } : matchTorrent(target, item.facts!);
      if (match.ok) matched.push({ ...item, ...base, pack: match.pack, lastSeason: last(item.facts!.seasons) });
      else rejected.push({ title: item.title, reason: match.reason ?? 'не подходит' });
    }
    return {
      candidates: pickCandidates(matched),
      matchedList: matched,
      found: unique.size,
      matched: matched.length,
      errors: [...new Set(errors)],
      failed: [...failed],
      rejected,
    };
  }

  private async jackett(base: string, query: string): Promise<FoundTorrent[]> {
    const url = `${base}/api/v2.0/indexers/all/results?apikey=${encodeURIComponent(this.options.apiKey)}&Query=${encodeURIComponent(query)}`;
    const interval = this.options.interval ?? 1500;
    for (let attempt = 0; ; attempt++) {
      const wait = (nextRequest.get(base) ?? 0) - Date.now();
      nextRequest.set(base, Math.max(Date.now(), nextRequest.get(base) ?? 0) + interval);
      if (wait > 0) await sleep(wait);
      const response = await (this.options.fetch ?? fetch)(url, {
        headers: { accept: 'application/json', 'user-agent': this.options.userAgent },
        signal: AbortSignal.timeout(30_000),
      });
      // Много запросов — ждём, сколько попросили (или 3 и 6 секунд), и пробуем ещё раз.
      if (response.status === 429 && attempt < 2) {
        const asked = Number(response.headers.get('retry-after'));
        await sleep(Number.isFinite(asked) && asked > 0 ? Math.min(asked, 20) * 1000 : (attempt + 1) * (this.options.retryDelay ?? 3000));
        continue;
      }
      if (!response.ok) throw new Error(response.status === 429 ? 'слишком много запросов (429), повторю позже' : `ответ ${response.status}`);
      const body = await response.text();
      if (body.length > MAX_RESPONSE) throw new Error('слишком большой ответ');
      const data = JSON.parse(body) as Raw;
      const results: unknown[] = Array.isArray(data?.Results) ? data.Results : Array.isArray(data) ? data : [];
      return results.map((item) => fromJackett(item as Raw, hostOf(base))).filter((item): item is FoundTorrent => item !== null);
    }
  }
}

/** Что сохранить о выбранной раздаче (см. Store.replaceFoundTorrents). */
export function foundInput(c: Candidate): FoundTorrentInput {
  const { source, magnet, infoHash, title, seeders, size, season, pack, episodes, lastSeason } = c;
  return { source, magnet, infoHash, title, seeders, size, season, pack, episodes, lastSeason };
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
