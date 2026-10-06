// Разбор раздачи аниме: какие файлы — серии, какие — звуковые дорожки озвучек.
// Типичная раздача с трекера выглядит так:
//   Title - 01 [BDRip 1080p].mkv            — видео (часто с несколькими дорожками внутри)
//   RUS Sound/[AniLibria]/Title - 01.mka    — озвучка внешним файлом, по папке на студию
//   RUS Subs/[Crunchyroll]/Title - 01.ass   — субтитры (пока не показываем)

export interface TorrentFileInfo {
  path: string;
  length: number;
}

export interface TorrentEpisode {
  ordinal: number;
  /** Индекс файла в раздаче. */
  file: number;
}

export interface ExternalDub {
  title: string;
  /** Серия → индекс файла с её звуком. */
  files: Record<number, number>;
}

export interface TorrentLayout {
  name: string;
  episodes: TorrentEpisode[];
  external: ExternalDub[];
}

const VIDEO = /\.(mkv|mp4|m4v|avi|webm|ts|m2ts|mov)$/i;
const AUDIO = /\.(mka|ac3|eac3|aac|m4a|mp3|flac|dts|opus|ogg|wav)$/i;
/** Папки, в которых лежат папки студий: их имя — не название озвучки. */
const GENERIC_DIR = /^(rus(sian)?[\s._-]*(sound|audio|dub)s?|(audio|sound)[\s._-]*tracks?|sounds?|audios?|звук|озвучк[аи]|(звуковые[\s._-]*)?дорожки|rus|eng|jpn)$/i;

/** Номер серии из имени файла: «Title - 05 [1080p]», «Title.S01E05», «[Group] Title 05v2». */
export function episodeNumber(filename: string): number | null {
  const base = filename.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
  const sxe = /s\d{1,2}[ ._-]?e(\d{1,4})/i.exec(base);
  if (sxe) return Number(sxe[1]);
  const cleaned = base
    // [Группа], [1080p], (2024) и т.п. — не номер серии.
    .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ')
    // Качество, кодеки и размер кадра (1920x1080) — тоже не номер серии.
    .replace(/(?<![a-z0-9])(\d{3,4}x\d{3,4}|\d{3,4}p|[hx]\.?26[45]|hevc|avc|10[ -]?bit|8[ -]?bit|aac\d?|ac3|flac|dts|opus|web[ -]?dl|web[ -]?rip|bd[ -]?rip|tv[ -]?rip|ova|ona|sp)(?![a-z0-9])/gi, ' ');
  // «Ep 05», «Episode 5», «серия 5», «E05» — но не буква «e» в конце слова («Title 2»).
  const ep = /(?<![a-zа-яё])(?:ep|episode|серия|эп)\.?[ ._-]*(\d{1,4})|(?<![a-zа-яё])e(\d{2,4})(?!\d)/i.exec(cleaned);
  if (ep) return Number(ep[1] ?? ep[2]);
  const numbers = [...cleaned.matchAll(/(?:^|[^\d.])(\d{1,4})(?:v\d)?(?![\d])/g)].map((m) => Number(m[1]));
  return numbers.length ? numbers[numbers.length - 1] : null;
}

/** Название озвучки по пути: ближайшая папка, которая не «RUS Sound», иначе [метка] в имени файла. */
function dubTitle(path: string): string {
  const parts = path.split('/');
  const dirs = parts.slice(0, -1).reverse();
  for (const dir of dirs.slice(0, Math.max(dirs.length - 1, 0))) {
    const name = dir.replace(/^[[(]+|[\])]+$/g, '').trim();
    if (name && !GENERIC_DIR.test(name.replace(/[[\]()]/g, '').trim())) return name;
  }
  const label = /\[([^\]]+)\][^[]*$/.exec(parts[parts.length - 1].replace(/\.[^.]+$/, ''));
  if (label && !/^\d{3,4}p$/i.test(label[1])) return label[1].trim();
  return 'Озвучка';
}

/** Серии и внешние озвучки раздачи. Один видеофайл — фильм или одна серия (номер 1). */
export function parseLayout(name: string, files: TorrentFileInfo[]): TorrentLayout {
  const videos = files.map((f, index) => ({ ...f, index })).filter((f) => VIDEO.test(f.path) && !/(^|\/)(sample|trailer|ncop|nced|pv)[^/]*$/i.test(f.path));
  const byOrdinal = new Map<number, TorrentEpisode>();
  if (videos.length === 1) {
    byOrdinal.set(1, { ordinal: 1, file: videos[0].index });
  } else {
    for (const video of videos) {
      const ordinal = episodeNumber(video.path);
      if (ordinal === null || ordinal <= 0 || ordinal > 3000) continue;
      // Две версии одной серии — берём большую (обычно это основная, а не сэмпл).
      const current = byOrdinal.get(ordinal);
      if (!current || files[current.file].length < video.length) byOrdinal.set(ordinal, { ordinal, file: video.index });
    }
  }
  const episodes = [...byOrdinal.values()].sort((a, b) => a.ordinal - b.ordinal);
  const single = episodes.length === 1 ? episodes[0].ordinal : null;

  const dubs = new Map<string, ExternalDub>();
  files.forEach((file, index) => {
    if (!AUDIO.test(file.path)) return;
    const ordinal = single ?? episodeNumber(file.path);
    if (ordinal === null || !byOrdinal.has(ordinal)) return;
    const title = dubTitle(file.path);
    const dub = dubs.get(title) ?? { title, files: {} };
    dub.files[ordinal] ??= index;
    dubs.set(title, dub);
  });
  return { name, episodes, external: [...dubs.values()].sort((a, b) => a.title.localeCompare(b.title, 'ru')) };
}
