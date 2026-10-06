// Раздачи из базы → плеер «Торрент» на странице просмотра. Раздачу добавляют командой
// `animini torrent add <тайтл> <magnet>`, сервер сам разбирает её: какие файлы — серии,
// какие озвучки лежат внутри видео и отдельными файлами, какое качество.

import type { Dub, PlayerSource } from '../../shared/types.ts';
import type { Store, TorrentRow } from '../db.ts';
import { parseLayout, type TorrentLayout } from './layout.ts';
import type { AudioChoice, SessionState, TorrentStreamer } from './streamer.ts';

export interface TorrentInfo {
  name: string;
  layout: TorrentLayout;
  height: number | null;
  videoCodec: string | null;
  /** Озвучки внутри видеофайла (номер среди звуковых дорожек). */
  embedded: { index: number; title: string | null; language: string | null }[];
}

const LANGUAGES: Record<string, string> = {
  rus: 'Русская дорожка',
  ru: 'Русская дорожка',
  jpn: 'Японская (оригинал)',
  ja: 'Японская (оригинал)',
  eng: 'Английская',
  en: 'Английская',
  ukr: 'Украинская',
  uk: 'Украинская',
};

export function qualityName(height: number | null): string | null {
  if (!height) return null;
  if (height >= 2000) return '4K';
  if (height >= 1000) return '1080p';
  if (height >= 700) return '720p';
  return `${height}p`;
}

/** Название встроенной дорожки: её заголовок, иначе язык, иначе номер. */
export function trackTitle(track: TorrentInfo['embedded'][number]): string {
  const title = track.title?.trim();
  if (title) return title;
  return (track.language && LANGUAGES[track.language.toLowerCase()]) || `Дорожка ${track.index + 1}`;
}

const isOriginal = (track: TorrentInfo['embedded'][number]) => /^(jpn|ja)$/i.test(track.language ?? '') || /japan|японск|original|оригинал/i.test(track.title ?? '');

/** Плеер для раздачи: озвучки — встроенные дорожки и внешние файлы, японская — в конце. */
export function torrentPlayer(row: TorrentRow, info: TorrentInfo): PlayerSource {
  const ordinals = info.layout.episodes.map((e) => e.ordinal);
  const last = ordinals.length ? Math.max(...ordinals) : null;
  const dubs: Dub[] = [];
  const embedded = [...info.embedded].sort((a, b) => Number(isOriginal(a)) - Number(isOriginal(b)));
  for (const track of embedded.filter((t) => !isOriginal(t))) {
    dubs.push({ id: `torrent-${row.id}:e${track.index}`, title: trackTitle(track), type: 'voice', link: '', lastEpisode: last, season: null, quality: info.height });
  }
  info.layout.external.forEach((dub, i) => {
    const own = Object.keys(dub.files).map(Number);
    dubs.push({ id: `torrent-${row.id}:x${i}`, title: dub.title, type: 'voice', link: '', lastEpisode: own.length ? Math.max(...own) : null, season: null, quality: info.height });
  });
  for (const track of embedded.filter(isOriginal)) {
    dubs.push({ id: `torrent-${row.id}:e${track.index}`, title: trackTitle(track), type: 'voice', link: '', lastEpisode: last, season: null, quality: info.height });
  }
  const quality = qualityName(info.height);
  return {
    id: `torrent-${row.id}`,
    title: `Торрент${quality ? ` ${quality}` : ''}`,
    kind: 'torrent',
    link: null,
    dubs,
    frame: null,
    events: null,
    lastEpisode: last,
    season: null,
    episodes: ordinals,
  };
}

export interface TorrentLibraryOptions {
  store: Store;
  streamer: TorrentStreamer;
  log: (message: string, error?: unknown) => void;
}

export class TorrentLibrary {
  private options: TorrentLibraryOptions;
  private resolving = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: TorrentLibraryOptions) {
    this.options = options;
  }

  /** Новые раздачи (их добавляет команда animini torrent add) разбираем в фоне. */
  start(): void {
    const tick = () => void this.resolvePending();
    tick();
    this.timer = setInterval(tick, 20_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  players(releaseId: number): PlayerSource[] {
    return this.options.store
      .torrents({ releaseId, status: 'ready' })
      .filter((row) => row.info)
      .map((row) => torrentPlayer(row, row.info as TorrentInfo))
      .filter((player) => player.episodes?.length);
  }

  /** Серия для плеера: id плеера «torrent-<n>», озвучка «torrent-<n>:e<дорожка>» или «:x<студия>». */
  play(playerId: string, dubId: string | null, ordinal: number): SessionState {
    const id = Number(/^torrent-(\d+)$/.exec(playerId)?.[1]);
    const row = id ? this.options.store.torrent(id) : null;
    const info = row?.status === 'ready' ? (row.info as TorrentInfo | null) : null;
    if (!row || !info) return { status: 'error', message: 'Раздача не найдена' };
    const episode = info.layout.episodes.find((e) => e.ordinal === ordinal);
    if (!episode) return { status: 'error', message: `В раздаче нет ${ordinal}-й серии` };

    const player = torrentPlayer(row, info);
    const dub = player.dubs.find((d) => d.id === dubId) ?? player.dubs[0];
    let audio: AudioChoice = { kind: 'embedded', index: 0 };
    const kind = dub ? /:(e|x)(\d+)$/.exec(dub.id) : null;
    if (kind?.[1] === 'e') audio = { kind: 'embedded', index: Number(kind[2]) };
    if (kind?.[1] === 'x') {
      const external = info.layout.external[Number(kind[2])];
      const file = external?.files[ordinal];
      if (file === undefined) return { status: 'error', message: `В озвучке «${external?.title ?? ''}» ${ordinal}-й серии нет` };
      audio = { kind: 'external', file };
    }
    return this.options.streamer.play({ magnet: row.magnet, infoHash: row.infoHash, video: episode.file, audio });
  }

  playlist(session: string): Promise<string | null> {
    return this.options.streamer.playlist(session);
  }

  file(session: string, name: string): string | null {
    return this.options.streamer.sessionFile(session, name);
  }

  private async resolvePending(): Promise<void> {
    if (this.resolving) return;
    this.resolving = true;
    try {
      for (const row of this.options.store.torrents({ status: 'pending' })) await this.resolve(row);
    } finally {
      this.resolving = false;
    }
  }

  /** Разбор раздачи: список файлов, серии, озвучки и качество (ffprobe первой серии). */
  private async resolve(row: TorrentRow): Promise<void> {
    const { store, streamer, log } = this.options;
    try {
      const meta = await streamer.metadata(row.magnet, row.infoHash);
      const layout = parseLayout(meta.name, meta.files);
      if (layout.episodes.length === 0) throw new Error('В раздаче не нашлось видеофайлов серий');
      const probe = await streamer.probe(row.magnet, row.infoHash, layout.episodes[0].file);
      const info: TorrentInfo = {
        name: meta.name,
        layout,
        height: probe.video?.height ?? null,
        videoCodec: probe.video?.codec ?? null,
        embedded: probe.audio.map((a) => ({ index: a.index, title: a.title, language: a.language })),
      };
      store.setTorrentReady(row.id, info);
      log(`Торрент: раздача «${meta.name}» готова — серий ${layout.episodes.length}, озвучек ${info.embedded.length + layout.external.length}`);
    } catch (error) {
      store.setTorrentError(row.id, error instanceof Error ? error.message : String(error));
      log(`Торрент: раздачу ${row.infoHash} не удалось разобрать`, error);
    }
  }
}
