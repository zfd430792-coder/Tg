// Название раздачи на трекере → что в ней (сезоны, годы, серии, качество, фильм или сериал)
// и подходит ли она тайтлу. Пишут названия по-разному:
//   Магическая битва (ТВ-2) / Jujutsu Kaisen 2nd Season [TV] [1-23 из 23] [RUS(int), JAP+Sub] [2023, WEBRip] [1080p]
//   Магическая битва (1 сезон: 1-24 серии из 24) / Jujutsu Kaisen (2020) BDRip 1080p | AniLibria, AniDub
//   [AniLibria.TV] Магическая битва / Jujutsu Kaisen [01-24] [WEBRip 1080p]
// Лучше не найти раздачу, чем показать чужой сезон: совпасть должны название, сезон и год,
// а фильм не подменяет сериал.

import type { Release } from '../../shared/types.ts';

/** Название с сезоном: «Ванпанчмен 3» — это «ванпанчмен», сезон 3. */
export interface NamedSeason {
  name: string;
  seasons: number[];
}

export interface TitleFacts {
  names: NamedSeason[];
  /** Сезоны, записанные явно: ТВ-2, 2 сезон, Season 2, 2nd Season, S02. */
  seasons: number[];
  years: [number, number] | null;
  episodes: { from: number; to: number; total: number | null } | null;
  height: number | null;
  movie: boolean;
  tv: boolean;
}

/** Что Jacred сам разобрал в названии раздачи (поле info). */
export interface JacredInfo {
  name?: unknown;
  originalname?: unknown;
  relased?: unknown;
  seasons?: unknown;
  quality?: unknown;
}

/** Для сравнения: строчные буквы и цифры без диакритики, ё → е. */
export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .trim();
}

function sameName(a: string, b: string): boolean {
  return a === b || a.replace(/ /g, '') === b.replace(/ /g, '');
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let n = from; n <= Math.min(to, from + 30); n++) out.push(n);
  return out;
}

/** Явно указанные сезоны: «ТВ-2», «ТВ-1, ТВ-2», «2 сезон», «1-3 сезоны», «Сезон 2», «Season 2», «2nd Season», «S02». */
export function explicitSeasons(text: string): number[] {
  const t = ` ${text.toLowerCase().replace(/ё/g, 'е')} `;
  const found = new Set<number>();
  const add = (numbers: number[]) => numbers.filter((n) => n >= 0 && n <= 60).forEach((n) => found.add(n));
  // ТВ-1, ТВ-2 / TV-1-3 / ТВ-1,2
  for (const m of t.matchAll(/(?<![a-zа-я0-9])(?:тв|tv)[\s-]*\d{1,2}(?:\s*(?:,|&|\+|-|и)\s*(?:(?:тв|tv)[\s-]*)?\d{1,2}(?![\d.]))*(?![\d.])/g)) {
    const chunk = m[0].replace(/тв|tv/g, ' ');
    const parts = [...chunk.matchAll(/(\d{1,2})(\s*-\s*(\d{1,2}))?/g)];
    for (const p of parts) add(p[3] ? range(Number(p[1]), Number(p[3])) : [Number(p[1])]);
  }
  for (const m of t.matchAll(/(?<![\d.])(\d{1,2})(?:\s*-\s*(\d{1,2}))?(?:-?(?:й|ый|ой|ий))?\s*сезон/g)) add(m[2] ? range(+m[1], +m[2]) : [+m[1]]);
  for (const m of t.matchAll(/сезон[а-я]*[\s№#]*(\d{1,2})(?![\d.])(?!\s*-\s*\d)/g)) add([+m[1]]);
  for (const m of t.matchAll(/season[s]?[\s#:-]*(\d{1,2})(?:\s*-\s*(\d{1,2}))?(?![\d.])/g)) add(m[2] ? range(+m[1], +m[2]) : [+m[1]]);
  for (const m of t.matchAll(/(?<![\d.])(\d{1,2})(?:st|nd|rd|th)\s+season/g)) add([+m[1]]);
  for (const m of t.matchAll(/(?<![a-z0-9])s(\d{1,2})(?:e\d{1,4})?(?:\s*-\s*s(\d{1,2}))?(?![a-z0-9])/g)) add(m[2] ? range(+m[1], +m[2]) : [+m[1]]);
  return [...found].sort((a, b) => a - b);
}

/** Годы выхода: «2020», «2020-2023». Разрешение кадра (1920x1080) годом не считаем. */
export function yearsOf(text: string): [number, number] | null {
  const years = [...text.matchAll(/(?<![\d.x×])(19[6-9]\d|20[0-4]\d)(?![\d.x×p])/gi)].map((m) => Number(m[1]));
  return years.length ? [Math.min(...years), Math.max(...years)] : null;
}

/** Серии: «[1-24 из 24]», «1-24 серии из 24», «[12 из 24]», «[01-24]». */
export function episodesOf(text: string): TitleFacts['episodes'] {
  const t = text.toLowerCase();
  const total = (value: string) => (/^\d+$/.test(value) ? Number(value) : null);
  const full = /(?<![\d.])(\d{1,4})\s*[-–]\s*(\d{1,4})\s*(?:серии|серия|сер\.?|эп\.?|эпизод\w*)?\s*(?:из|of)\s*(\d{1,4}|x+|\?+)/.exec(t);
  if (full) return { from: Number(full[1]), to: Number(full[2]), total: total(full[3]) };
  const count = /(?<![\d.-])(\d{1,4})\s*(?:серии|серия|сер\.?|эп\.?)?\s*из\s*(\d{1,4}|x+|\?+)/.exec(t);
  if (count) return { from: 1, to: Number(count[1]), total: total(count[2]) };
  const bracket = /\[\s*(\d{1,4})\s*[-–]\s*(\d{1,4})\s*\]/.exec(t);
  if (bracket && Number(bracket[2]) < 1900) return { from: Number(bracket[1]), to: Number(bracket[2]), total: null };
  return null;
}

/** Качество (высота кадра) по названию. */
export function heightOf(text: string): number | null {
  const t = text.toLowerCase();
  if (/(?<![a-z0-9])(2160p|4k|uhd)(?![a-z0-9])/.test(t)) return 2160;
  if (/(?<![a-z0-9])1440p(?![a-z0-9])/.test(t)) return 1440;
  if (/(?<![a-z0-9])1080[pi](?![a-z0-9])/.test(t)) return 1080;
  if (/(?<![a-z0-9])720p(?![a-z0-9])/.test(t)) return 720;
  if (/(?<![a-z0-9])(576p|480p|dvdrip|dvd5|dvd9)(?![a-z0-9])/.test(t)) return 480;
  const frame = /(?<!\d)\d{3,4}[x×](\d{3,4})(?!\d)/.exec(t);
  return frame ? Number(frame[1]) : null;
}

const SEASON_TEXT =
  /(?<![a-zа-яё0-9])(?:(?:тв|tv)[\s-]*\d{1,2}(?:\s*[,&+и-]\s*(?:(?:тв|tv)[\s-]*)?\d{1,2})*|\d{1,2}(?:\s*-\s*\d{1,2})?(?:-?(?:й|ый|ой|ий))?\s*сезон[а-яё]*|сезон[а-яё]*[\s№#:]*\d{1,2}|seasons?[\s#:-]*\d{1,2}(?:\s*-\s*\d{1,2})?|\d{1,2}(?:st|nd|rd|th)\s+season|s\d{1,2}(?:e\d{1,4})?)(?![a-zа-яё0-9])/gi;
/** Хвост с подробностями о рипе: «BDRip 1080p», «WEB-DL», «HEVC» и всё после. */
const TECH_TAIL = /(?<![a-zа-яё])(?:bd|web|tv|dvd|hdtv|hd)[\s-]?(?:rip|dl|remux|dlrip)(?![a-zа-яё]).*$|(?<![a-z0-9])\d{3,4}[pi](?![a-z0-9]).*$/i;

/** Часть названия без сезона, года, скобок и технических подробностей. */
function cleanPart(part: string): string {
  return part
    .replace(/\([^)]*\)|\{[^}]*\}|\[[^\]]*\]/g, ' ')
    .replace(TECH_TAIL, ' ')
    .replace(SEASON_TEXT, ' ')
    .replace(/(?<![\d.])(?:19[6-9]\d|20[0-4]\d)(?![\d.])/g, ' ');
}

const ROMAN: Record<string, number> = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8 };

/** «ванпанчмен 3» → { base: «ванпанчмен», n: 3 }; «моб психо 100 iii» → { «моб психо 100», 3 }. */
function trailingSeason(name: string): { base: string; n: number } | null {
  const m = /^(.+?) (\d{1,2}|ii|iii|iv|v|vi|vii|viii)$/.exec(name);
  if (!m) return null;
  const n = ROMAN[m[2]] ?? Number(m[2]);
  return n <= 10 ? { base: m[1], n } : null;
}

/** Варианты названия с сезонами: явные сезоны — для всех частей, иначе число в конце или 1-й сезон. */
function variants(parts: string[], explicit: number[]): NamedSeason[] {
  const out: NamedSeason[] = [];
  for (const part of parts) {
    const full = normalizeName(cleanPart(part));
    if (full.length < 2) continue;
    const tail = trailingSeason(full);
    if (explicit.length) {
      out.push({ name: full, seasons: explicit });
      if (tail && explicit.includes(tail.n)) out.push({ name: tail.base, seasons: explicit });
    } else {
      out.push({ name: full, seasons: [1] });
      if (tail) out.push({ name: tail.base, seasons: [tail.n] });
    }
  }
  return out;
}

/** Части названия раздачи до технических подробностей: «Русское / Original / Alt». */
function titleParts(title: string): string[] {
  let main = title.replace(/^\s*(?:\[[^\]]*\]\s*)+/, '');
  main = main.split(/\s\|\s/)[0];
  const bracket = main.indexOf('[');
  if (bracket > 0) main = main.slice(0, bracket);
  return main
    .split(/\s+\/\s+/)
    .map((p) => p.trim())
    .filter((p) => p && !/^(19|20)\d{2}$/.test(p));
}

/** Всё, что можно понять о раздаче по её названию (и по разбору Jacred, если он есть). */
export function titleFacts(title: string, info?: JacredInfo | null): TitleFacts {
  const fromInfo = Array.isArray(info?.seasons) ? info.seasons.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 60) : [];
  const seasons = [...new Set([...explicitSeasons(title), ...fromInfo])].sort((a, b) => a - b);
  const parts = titleParts(title);
  for (const extra of [info?.name, info?.originalname]) if (typeof extra === 'string' && extra.trim()) parts.push(extra);
  const released = Number(info?.relased);
  const years = yearsOf(title) ?? (Number.isInteger(released) && released > 1950 ? ([released, released] as [number, number]) : null);
  const episodes = episodesOf(title);
  const lower = title.toLowerCase();
  return {
    names: variants(parts, seasons),
    seasons,
    years,
    episodes,
    height: heightOf(title) ?? (Number(info?.quality) >= 240 ? Number(info?.quality) : null),
    movie: /\[(?:movie|film|фильм)\]|\((?:movie|фильм)\)|(?<![a-zа-яё])(?:movie|фильм|полнометражн[а-яё]*)(?![a-zа-яё])/i.test(title),
    tv: /\[(?:tv|тв)\]|(?<![a-zа-яё])(?:tv|тв)[\s-]*\d|(?<![a-zа-яё])(?:сериал|series)(?![a-zа-яё])/i.test(lower),
  };
}

export interface ReleaseTarget {
  names: { name: string; season: number }[];
  /** Сезон тайтла: по нему из сборника сезонов берём нужную папку. */
  season: number;
  year: number | null;
  movie: boolean;
  episodesTotal: number | null;
}

type ReleaseLike = Pick<Release, 'title' | 'titleEn' | 'year' | 'type' | 'episodesTotal'> & { titleAlt?: string | null };

/** Как искать тайтл: варианты названия с сезоном, год, фильм ли это. */
export function releaseTarget(release: ReleaseLike): ReleaseTarget {
  const explicit = explicitSeasons(release.title)[0] ?? explicitSeasons(release.titleEn ?? '')[0] ?? null;
  const names: ReleaseTarget['names'] = [];
  let season = explicit;
  for (const title of [release.title, release.titleEn, release.titleAlt]) {
    if (!title) continue;
    // «Синяя тюрьма: Блю Лок» ищем и как «Синяя тюрьма».
    for (const part of new Set([title, title.split(/:\s/)[0]])) {
      const full = normalizeName(cleanPart(part));
      if (full.length < 2) continue;
      const tail = trailingSeason(full);
      if (explicit !== null) {
        names.push({ name: full, season: explicit });
        if (tail && tail.n === explicit) names.push({ name: tail.base, season: explicit });
      } else {
        names.push({ name: full, season: 1 });
        if (tail) {
          names.push({ name: tail.base, season: tail.n });
          // AniLibria называет сезоны «Название 2» — так сезон тайтла и узнаём.
          if (title === release.title && season === null) season = tail.n;
        }
      }
    }
  }
  return {
    names,
    season: season ?? 1,
    year: release.year,
    movie: /фильм|movie/i.test(release.type ?? ''),
    episodesTotal: release.episodesTotal,
  };
}

export interface TorrentMatch {
  ok: boolean;
  /** Раздача — сборник нескольких сезонов: из неё нужна папка своего сезона. */
  pack: boolean;
  reason?: string;
}

/** Подходит ли раздача тайтлу: название и сезон, год (±1), фильм или сериал, число серий. */
export function matchTorrent(target: ReleaseTarget, facts: TitleFacts): TorrentMatch {
  let named = false;
  let pack = false;
  for (const ours of target.names) {
    for (const theirs of facts.names) {
      if (!sameName(ours.name, theirs.name) || !theirs.seasons.includes(ours.season)) continue;
      named = true;
      pack ||= theirs.seasons.length > 1;
    }
  }
  if (!named) return { ok: false, pack: false, reason: 'другое название или сезон' };
  if (target.year) {
    if (!facts.years) return { ok: false, pack, reason: 'в названии нет года' };
    const [from, to] = facts.years;
    if (target.year < from - 1 || target.year > to + 1) return { ok: false, pack, reason: `другой год (${from === to ? from : `${from}-${to}`})` };
  }
  const many = facts.episodes ? (facts.episodes.total ?? facts.episodes.to) > 1 : false;
  if (target.movie && (facts.tv || many)) return { ok: false, pack, reason: 'сериал, а нужен фильм' };
  if (!target.movie && facts.movie && !facts.tv && !many) return { ok: false, pack, reason: 'фильм, а нужен сериал' };
  const total = facts.episodes?.total;
  if (!pack && target.episodesTotal && total && Math.abs(total - target.episodesTotal) > 2) {
    return { ok: false, pack, reason: `другое число серий (${total})` };
  }
  return { ok: true, pack };
}

/** Что спрашивать у поиска: название без сезона, по-русски и в оригинале. */
export function searchQueries(release: ReleaseLike): string[] {
  const out = new Set<string>();
  for (const title of [release.title, release.titleEn]) {
    if (!title) continue;
    let query = cleanPart(title).replace(/\s+/g, ' ').trim();
    const tail = /^(.+?)\s+(\d{1,2}|II|III|IV|V|VI|VII|VIII)$/i.exec(query);
    if (tail && (ROMAN[tail[2].toLowerCase()] ?? Number(tail[2])) <= 10) query = tail[1];
    query = query.replace(/[\s:;,.!?-]+$/, '').trim();
    if (query.length >= 2) out.add(query);
  }
  return [...out];
}
