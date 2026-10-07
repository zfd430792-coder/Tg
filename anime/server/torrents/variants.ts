// Все раздачи тайтла → один плеер «Торрент»: озвучки со всех раздач одним списком, у каждой —
// варианты качества (раздача + дорожка в ней). Одна и та же студия в разных раздачах
// подписана по-разному («AniLibria.TV», «MVO | AniLibria», «[AniLibria]») — сводим в одну.

import type { Dub, PlayerSource, TorrentVariant } from '../../shared/types.ts';
import type { TorrentRow } from '../db.ts';
import type { TorrentLayout } from './layout.ts';
import { knownStudio } from './studios.ts';
import { normalizeName } from './titles.ts';

export interface TorrentInfo {
  name: string;
  layout: TorrentLayout;
  height: number | null;
  videoCodec: string | null;
  /** 10 бит на цвет: H.264 10-bit браузеры не показывают — такое видео перекодируем. */
  tenBit?: boolean;
  /** Озвучки внутри видеофайла (номер среди звуковых дорожек). */
  embedded: { index: number; title: string | null; language: string | null }[];
}

const LANGUAGES: Record<string, string> = {
  rus: 'Русская озвучка',
  ru: 'Русская озвучка',
  jpn: 'Японская (оригинал)',
  ja: 'Японская (оригинал)',
  eng: 'Английская',
  en: 'Английская',
  ukr: 'Украинская',
  uk: 'Украинская',
};

/** Слова, которые не называют студию: «Rus», «MVO», «Многоголосая закадровая», «AC3 5.1»… */
const GENERIC_WORD =
  /^(?:rus(?:sian)?|ru|eng(?:lish)?|jpn|jap(?:anese)?|ukr|рус(?:ский|ская|ское)?|русск[а-яё]*|англ[а-яё]*|японск[а-яё]*|многоголос[а-яё]*|двухголос[а-яё]*|одноголос[а-яё]*|закадров[а-яё]*|дублир[а-яё]*|дубляж[а-яё]*|профессиональн[а-яё]*|любительск[а-яё]*|авторск[а-яё]*|полное|mvo|dvo|avo|vo|pro|dub|dubbing|sound|audio|track|дорожк[а-яё]*|озвучк[а-яё]*|озвучан[а-яё]*|перевод[а-яё]*|звук|stereo|стерео|аудио|aac|ac3|eac3|e-ac3|dts|flac|opus|mp3|ch|kbps|кбит[а-яё/]*|tv|тв|int|ext|original|оригинал[а-яё]*|default|lq|hq|\d+(?:\.\d+)?)$/i;

const isGeneric = (segment: string) =>
  segment
    .split(/[\s._-]+/)
    .filter(Boolean)
    .every((word) => GENERIC_WORD.test(word));

/** Название студии из подписи дорожки: «MVO | AniLibria.TV» → «AniLibria.TV»; только общие слова → null. */
export function studioOf(title: string | null): string | null {
  if (!title) return null;
  const segments = title
    .split(/[|,/;()[\]{}«»"]+|\s[-–—]\s/)
    .map((s) => s.trim())
    .filter(Boolean);
  const named = segments.find((s) => !isGeneric(s));
  return named ?? null;
}

/** Ключ студии для сравнения: «AniLibria.TV» и «[AniLibria]» — одна студия, «SHIZA Project» и «SHIZA» — тоже. */
export function studioKey(studio: string): string {
  return normalizeName(studio.replace(/\.(?:tv|top|ru|club|com|org|pro|online|net)\b/gi, ' '))
    .split(' ')
    .filter((w) => w && !/^(?:studio|studios|project|team|group|records|sound|club|dub|dubbing|студия|проект)$/.test(w))
    .join('');
}

export const isOriginalTrack = (track: { title: string | null; language: string | null }) =>
  /^(jpn|ja)$/i.test(track.language ?? '') || /japan|японск|оригинал|(?:^|[^a-z])(?:original|jap|jpn)(?:[^a-z]|$)/i.test(track.title ?? '');

/** Одна дорожка (встроенная или внешней папкой) — это озвучка с ключом, подписью и местом в списке. */
interface Track {
  key: string;
  title: string;
  original: boolean;
  /** Популярные студии (Dream Cast, AniDub, Studio Band…) — первыми, см. studios.ts. */
  order: number;
}

const UNKNOWN = 1000;

/** Студия из подписи: известная — под своим именем («MVO | DreamCast» → «Dream Cast»), иначе как подписана. */
function studioTrack(label: string | null, fallbackKey: string): Track | null {
  const known = label ? knownStudio(label) : null;
  if (known) return { key: studioKey(known.name), title: known.name, original: false, order: known.order };
  const studio = studioOf(label);
  if (studio) return { key: studioKey(studio) || fallbackKey, title: studio, original: false, order: UNKNOWN };
  // «Дубляж» без студии — официальный полный дубляж, а не безымянная закадровая озвучка.
  if (label && /дубляж|dubbing|(?:^|[^a-z])dub(?:[^a-z]|$)/i.test(label)) return { key: 'dubbing', title: 'Дубляж', original: false, order: UNKNOWN - 1 };
  return null;
}

function embeddedTrack(rowId: number, track: TorrentInfo['embedded'][number]): Track {
  if (isOriginalTrack(track)) return { key: 'jpn', title: 'Японская (оригинал)', original: true, order: UNKNOWN };
  const studio = studioTrack(track.title, `t${rowId}e${track.index}`);
  if (studio) return studio;
  const language = track.language?.toLowerCase() ?? '';
  // «Русская озвучка» без студии в разных раздачах — разные озвучки: не сводим их вместе.
  const title = LANGUAGES[language] ?? `Дорожка ${track.index + 1}`;
  return { key: /^(eng|en)$/.test(language) ? 'eng' : `t${rowId}e${track.index}`, title, original: false, order: UNKNOWN + 1 };
}

function externalTrack(rowId: number, index: number, title: string): Track {
  return studioTrack(title, `t${rowId}x${index}`) ?? { key: `t${rowId}x${index}`, title, original: false, order: UNKNOWN + 1 };
}

/** Видео в браузере: H.264 10 бит и редкие кодеки сервер перекодирует в H.264 (не выше 1080p). */
export function servedVideo(info: Pick<TorrentInfo, 'videoCodec' | 'tenBit' | 'height'>): { codec: string | null; height: number | null; transcode: boolean; tenBit: boolean } {
  const codec = info.videoCodec;
  const transcode = Boolean(codec) && !(codec === 'hevc' || codec === 'av1' || (codec === 'h264' && !info.tenBit));
  if (transcode) return { codec: 'h264', height: info.height ? Math.min(info.height, 1080) : null, transcode, tenBit: false };
  return { codec, height: info.height, transcode, tenBit: Boolean(info.tenBit) };
}

export type TorrentStatus = 'searching' | 'more' | null;

/**
 * Плеер «Торрент» из всех разобранных раздач тайтла. Озвучки: сначала популярные студии
 * (Dream Cast, AniDub, Studio Band, AniLibria…), потом остальные по числу раздающих, японская —
 * в конце; у каждой — варианты (раздача и дорожка в ней) с качеством и сериями.
 */
export function torrentSource(entries: { row: TorrentRow; info: TorrentInfo }[], status: TorrentStatus): PlayerSource | null {
  const variants: TorrentVariant[] = [];
  const tracks = new Map<string, { title: string; titles: string[]; original: boolean; order: number; seeders: number }>();
  const add = (row: TorrentRow, info: TorrentInfo, id: string, track: Track, episodes: number[]) => {
    if (episodes.length === 0) return;
    const served = servedVideo(info);
    const dub = `torrent:${track.key}`;
    variants.push({ id, dub, height: served.height, codec: served.codec, tenBit: served.tenBit, transcode: served.transcode, episodes, seeders: row.seeders ?? 0 });
    const group = tracks.get(dub) ?? { title: track.title, titles: [], original: track.original, order: track.order, seeders: 0 };
    group.titles.push(track.title);
    group.seeders += (row.seeders ?? 0) + 1;
    tracks.set(dub, group);
  };
  for (const { row, info } of entries) {
    const ordinals = info.layout.episodes.map((e) => e.ordinal);
    for (const track of info.embedded) add(row, info, `${row.id}:e${track.index}`, embeddedTrack(row.id, track), ordinals);
    info.layout.external.forEach((dub, i) => {
      add(row, info, `${row.id}:x${i}`, externalTrack(row.id, i, dub.title), Object.keys(dub.files).map(Number).filter((n) => ordinals.includes(n)));
    });
  }
  if (variants.length === 0) {
    return status === 'searching' ? emptySource(status) : null;
  }

  const dubs: Dub[] = [...tracks.entries()]
    .sort(([, a], [, b]) => Number(a.original) - Number(b.original) || a.order - b.order || b.seeders - a.seeders || a.title.localeCompare(b.title, 'ru'))
    .map(([id, group]) => {
      const own = variants.filter((v) => v.dub === id);
      // Подпись — самая короткая из встретившихся: «AniLibria», а не «AniLibria.TV MVO».
      const title = [...group.titles].sort((a, b) => a.length - b.length)[0];
      return {
        id,
        title,
        type: 'voice',
        link: '',
        lastEpisode: Math.max(...own.flatMap((v) => v.episodes)),
        season: null,
        quality: Math.max(0, ...own.map((v) => v.height ?? 0)) || null,
      } satisfies Dub;
    });
  // Две озвучки без студии в подписи («Русская озвучка») различаем номером.
  const seen = new Map<string, number>();
  for (const dub of dubs) {
    const n = (seen.get(dub.title) ?? 0) + 1;
    seen.set(dub.title, n);
    if (n > 1) dub.title = `${dub.title} ${n}`;
  }
  const episodes = [...new Set(variants.flatMap((v) => v.episodes))].sort((a, b) => a - b);
  return {
    id: 'torrent',
    title: 'Торрент',
    kind: 'torrent',
    link: null,
    dubs,
    frame: null,
    events: null,
    lastEpisode: episodes.length ? episodes[episodes.length - 1] : null,
    season: null,
    episodes,
    variants,
    status,
  };
}

function emptySource(status: TorrentStatus): PlayerSource {
  return { id: 'torrent', title: 'Торрент', kind: 'torrent', link: null, dubs: [], frame: null, events: null, lastEpisode: null, season: null, episodes: [], variants: [], status };
}

/** Вариант по id «<раздача>:e<дорожка>» или «<раздача>:x<папка озвучки>». */
export function parseVariant(id: string): { row: number; kind: 'e' | 'x'; index: number } | null {
  const m = /^(\d{1,9}):([ex])(\d{1,4})$/.exec(id);
  return m ? { row: Number(m[1]), kind: m[2] as 'e' | 'x', index: Number(m[3]) } : null;
}
