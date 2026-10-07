// Раздачи тайтла → плеер «Торрент» на странице просмотра. Раздачи сервер находит сам (см.
// search.ts), когда тайтл открывают, и разбирает в фоне: какие файлы — серии, какие озвучки
// внутри видео и отдельными файлами, какое качество. Свою раздачу можно добавить и руками:
// `animini torrent add <тайтл> <magnet>`.

import type { PlayerSource, Release } from '../../shared/types.ts';
import type { Store, TorrentRow } from '../db.ts';
import { parseLayout } from './layout.ts';
import { foundInput, type SearchReport, type TorrentSearch } from './search.ts';
import type { AudioChoice, SessionState, TorrentStreamer } from './streamer.ts';
import { parseVariant, type TorrentInfo, torrentSource } from './variants.ts';

export type { TorrentInfo } from './variants.ts';

export interface TorrentLibraryOptions {
  store: Store;
  streamer: TorrentStreamer;
  /** Поиск раздач; без него — только добавленные руками. */
  search?: TorrentSearch | null;
  log: (message: string, error?: unknown) => void;
}

/** Как часто искать раздачи заново: у онгоингов выходят серии, у вышедших — новые рипы. */
const SEARCH_AGAIN = { ongoing: 12 * 3600_000, finished: 3 * 86400_000, failed: 30 * 60_000, empty: 86400_000 };
/** Сколько раздач разбирать одновременно (это ожидание раздающих, а не работа процессора) и сколько тайтлов искать. */
const RESOLVE_AT_ONCE = 5;
const SEARCH_AT_ONCE = 2;
/** Не больше стольких разборов в час: каждый — подключение к раздаче и пара мегабайт начала серии. */
const RESOLVES_PER_HOUR = 60;

export class TorrentLibrary {
  private options: TorrentLibraryOptions;
  private timer: NodeJS.Timeout | null = null;
  private resolving = new Set<number>();
  private searching = new Map<number, Promise<SearchReport | null>>();
  private searchQueue: (() => void)[] = [];
  private activeSearches = 0;
  private resolvedAt: number[] = [];
  /** Когда тайтл последний раз открывали: его раздачи разбираем раньше остальных. */
  private wanted = new Map<number, number>();
  private logged = new Map<string, number>();

  constructor(options: TorrentLibraryOptions) {
    this.options = options;
  }

  /** Разбор новых раздач — в фоне; раз в 20 секунд проверяем, не появились ли новые. */
  start(): void {
    this.kick();
    this.timer = setInterval(() => this.kick(), 20_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Плеер «Торрент» для тайтла (если раздачи есть или ещё ищутся); search — поискать, если давно не искали. */
  players(release: Release, options: { search?: boolean } = {}): PlayerSource[] {
    if (options.search) {
      this.wanted.set(release.id, Date.now());
      if (this.wanted.size > 1000) this.wanted.delete(this.wanted.keys().next().value as number);
      this.ensureSearch(release);
    }
    const rows = this.options.store.torrents({ releaseId: release.id });
    const ready = rows.filter((row) => row.status === 'ready' && row.info).map((row) => ({ row, info: row.info as TorrentInfo }));
    const busy = this.searching.has(release.id) || rows.some((row) => row.status === 'pending');
    const source = torrentSource(ready, busy ? (ready.length ? 'more' : 'searching') : null);
    return source ? [source] : [];
  }

  /** Найти раздачи для тайтла сейчас (для `animini torrent search`) и сохранить, что подошло. */
  async searchNow(release: Release): Promise<SearchReport | null> {
    return this.runSearch(release);
  }

  /**
   * Серия для плеера: вариант «<раздача>:e<дорожка>» или «<раздача>:x<папка озвучки>».
   * start — с какой секунды (перемотка, смена озвучки), previous — сессия, которую бросили.
   */
  play(variantId: string, ordinal: number, start = 0, previous: string | null = null, transcode = false): SessionState {
    const variant = parseVariant(variantId);
    const row = variant ? this.options.store.torrent(variant.row) : null;
    const info = row?.status === 'ready' ? (row.info as TorrentInfo | null) : null;
    if (!variant || !row || !info) return { status: 'error', message: 'Раздача больше недоступна — обновите страницу' };
    const episode = info.layout.episodes.find((e) => e.ordinal === ordinal);
    if (!episode) return { status: 'error', message: `В этой раздаче нет ${ordinal}-й серии` };
    let audio: AudioChoice = { kind: 'embedded', index: variant.index };
    if (variant.kind === 'e' && !info.embedded.some((t) => t.index === variant.index)) return { status: 'error', message: 'Такой дорожки в раздаче нет' };
    if (variant.kind === 'x') {
      const external = info.layout.external[variant.index];
      const file = external?.files[ordinal];
      if (file === undefined) return { status: 'error', message: `В озвучке «${external?.title ?? ''}» ${ordinal}-й серии нет` };
      audio = { kind: 'external', file };
    }
    return this.options.streamer.play({ magnet: row.magnet, infoHash: row.infoHash, video: episode.file, audio, start, previous, transcode });
  }

  playlist(session: string): Promise<string | null> {
    return this.options.streamer.playlist(session);
  }

  file(session: string, name: string): string | null {
    return this.options.streamer.sessionFile(session, name);
  }

  /** Искать ли раздачи снова: давно не искали (у онгоинга — чаще) или прошлый поиск не удался. */
  private ensureSearch(release: Release): void {
    if (!this.options.search || this.searching.has(release.id)) return;
    const last = this.options.store.torrentSearch(release.id);
    if (last) {
      const age = Date.now() - Date.parse(last.searchedAt);
      const wait = last.error && last.found === 0 ? SEARCH_AGAIN.failed : last.found === 0 ? SEARCH_AGAIN.empty : release.isOngoing ? SEARCH_AGAIN.ongoing : SEARCH_AGAIN.finished;
      if (age < wait) return;
    }
    void this.runSearch(release);
  }

  private runSearch(release: Release): Promise<SearchReport | null> {
    const running = this.searching.get(release.id);
    if (running) return running;
    const task = this.queued(async () => {
      const { store, search, log } = this.options;
      if (!search) return null;
      try {
        const report = await search.find(release);
        // Источники не ответили и ничего не нашлось — старые раздачи не трогаем, повторим позже.
        if (report.candidates.length > 0 || report.failed.length === 0) {
          store.replaceFoundTorrents(
            release.id,
            report.candidates.map(foundInput),
            report.failed,
            // Раздачу, которую сейчас смотрят, не убираем, даже если поиск её больше не нашёл.
            this.options.streamer.activeHashes(),
          );
        }
        store.saveTorrentSearch(release.id, report.candidates.length, report.errors.join('; ') || null);
        // Недоступный источник — в лог раз в 10 минут, а не на каждый тайтл.
        for (const error of report.errors) this.logOnce(`Торрент: поиск раздач — ${error}`);
        return report;
      } catch (error) {
        store.saveTorrentSearch(release.id, 0, error instanceof Error ? error.message : String(error));
        log(`Торрент: не удалось найти раздачи для «${release.title}»`, error);
        return null;
      } finally {
        this.searching.delete(release.id);
        this.kick();
      }
    });
    this.searching.set(release.id, task);
    return task;
  }

  private logOnce(message: string): void {
    const last = this.logged.get(message) ?? 0;
    if (Date.now() - last < 10 * 60_000) return;
    this.logged.set(message, Date.now());
    if (this.logged.size > 200) this.logged.delete(this.logged.keys().next().value as string);
    this.options.log(message);
  }

  /** Не больше SEARCH_AT_ONCE поисков одновременно, остальные ждут в очереди. */
  private queued<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.activeSearches += 1;
        work()
          .then(resolve, reject)
          .finally(() => {
            this.activeSearches -= 1;
            this.searchQueue.shift()?.();
          });
      };
      if (this.activeSearches < SEARCH_AT_ONCE) run();
      else this.searchQueue.push(run);
    });
  }

  /**
   * Разобрать раздачи из очереди, по RESOLVE_AT_ONCE за раз: сначала тайтла, который открыли
   * последним (его ждёт зритель), а у тайтла — в порядке поиска (популярные студии первыми).
   */
  private kick(): void {
    if (this.resolving.size >= RESOLVE_AT_ONCE) return;
    const hourAgo = Date.now() - 3600_000;
    this.resolvedAt = this.resolvedAt.filter((at) => at > hourAgo);
    const pending = this.options.store.torrents({ status: 'pending' });
    pending.sort((a, b) => (this.wanted.get(b.releaseId) ?? 0) - (this.wanted.get(a.releaseId) ?? 0) || a.id - b.id);
    for (const row of pending) {
      if (this.resolving.size >= RESOLVE_AT_ONCE || this.resolvedAt.length >= RESOLVES_PER_HOUR) break;
      if (this.resolving.has(row.id)) continue;
      this.resolving.add(row.id);
      this.resolvedAt.push(Date.now());
      void this.resolve(row).finally(() => {
        this.resolving.delete(row.id);
        this.kick();
      });
    }
  }

  /** Разбор раздачи: список файлов, серии, озвучки и качество (ffprobe первой серии). */
  private async resolve(row: TorrentRow): Promise<void> {
    const { store, streamer, log } = this.options;
    try {
      const meta = await streamer.metadata(row.magnet, row.infoHash);
      const hint = row.hint?.pack ? row.hint : null;
      const layout = parseLayout(meta.name, meta.files, { season: hint?.season ?? null, episodes: hint?.episodes ?? null, lastSeason: hint?.lastSeason ?? true });
      if (layout.episodes.length === 0) throw new Error(row.hint?.pack ? `В сборнике нет папки ${row.hint.season}-го сезона` : 'В раздаче не нашлось видеофайлов серий');
      const probe = await streamer.probe(row.magnet, row.infoHash, layout.episodes[0].file);
      if (!probe.video) throw new Error('В первой серии нет видео');
      const info: TorrentInfo = {
        name: meta.name,
        layout,
        height: probe.video.height,
        videoCodec: probe.video.codec,
        tenBit: probe.video.tenBit,
        embedded: probe.audio.map((a) => ({ index: a.index, title: a.title, language: a.language })),
      };
      // Раздачу могли удалить, пока её разбирали (новый поиск её не нашёл).
      if (!store.torrent(row.id)) return;
      store.setTorrentReady(row.id, info);
      log(`Торрент: раздача «${meta.name}» готова — серий ${layout.episodes.length}, озвучек ${info.embedded.length + layout.external.length}, ${probe.video.height ?? '?'}p ${probe.video.codec}`);
    } catch (error) {
      if (!store.torrent(row.id)) return;
      store.setTorrentError(row.id, error instanceof Error ? error.message : String(error));
      log(`Торрент: раздачу ${row.title ?? row.infoHash} не удалось разобрать: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
