// Смотрим серии прямо из торрент-раздачи. Браузер сам торрент качать не умеет, поэтому:
//   1. сервер качает только нужные куски нужного файла (раздачу целиком — нет);
//   2. ffmpeg на лету перекладывает видео из .mkv в HLS (сегменты fMP4) — без
//      перекодирования, если браузер понимает кодек, — и подмешивает выбранную озвучку;
//   3. наш плеер играет HLS, как серии AniLibria.
// На диске остаётся только кэш недавно просмотренного (с лимитом), HLS-сегменты
// удаляются, когда серию перестают смотреть.

import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readdir, readFile, rm, stat, statfs } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import WebTorrent from 'webtorrent';
import type { TorrentFileInfo } from './layout.ts';

export interface StreamerOptions {
  /** Папка для кэша раздач и HLS-сегментов. */
  dir: string;
  /** Сколько места можно занять кэшем раздач, байт. */
  cacheBytes: number;
  /** Сколько серий одновременно может готовить ffmpeg. */
  maxSessions: number;
  /** Ограничение отдачи другим участникам раздачи, байт/с; -1 — без ограничения. */
  uploadLimit: number;
  /** DHT нужен для magnet-ссылок без трекеров; в тестах выключаем. */
  dht: boolean;
  /** Разрешить участников раздачи с локальных и внутренних адресов (только для тестов). */
  allowLocalPeers?: boolean;
  log: (message: string, error?: unknown) => void;
  ffmpeg?: string;
  ffprobe?: string;
}

export interface ProbeInfo {
  duration: number | null;
  video: { codec: string; height: number | null; tenBit: boolean } | null;
  /** Звуковые дорожки по порядку (index — номер среди звуковых, для -map 0:a:N). */
  audio: { index: number; codec: string; channels: number; title: string | null; language: string | null }[];
}

export type AudioChoice = { kind: 'embedded'; index: number } | { kind: 'external'; file: number };

export interface PlayRequest {
  magnet: string;
  infoHash: string;
  video: number;
  audio: AudioChoice;
  /** С какой секунды готовить серию: после перемотки вперёд или смены озвучки на середине. */
  start?: number;
  /** Сессия, которую зритель только что бросил (сменил озвучку, качество, перемотал). */
  previous?: string | null;
  /** Перекодировать в H.264 даже HEVC: устройство зрителя HEVC не показывает. */
  transcode?: boolean;
}

export type SessionState =
  | { status: 'starting'; message: string; peers: number; speed: number }
  | { status: 'ready'; session: string; duration: number | null; height: number | null; codec: string | null; offset: number }
  | { status: 'error'; message: string }
  | { status: 'busy'; message: string };

interface Session {
  id: string;
  infoHash: string;
  dir: string;
  proc: ChildProcess | null;
  state: SessionState;
  lastAccess: number;
  /** ffmpeg перекодирует видео (H.264 10 бит): тяжело для процессора, одновременно — одна такая. */
  transcode: boolean;
  /** Зритель ушёл с этой сессии на другую. */
  released: boolean;
  /** Когда сессия закончилась ошибкой или отказом: повторный запрос через пару секунд — новая попытка. */
  failedAt: number | null;
}

/**
 * Локальные и внутренние адреса: список участников раздачи приходит от чужих трекеров и
 * пиров, и без этого через него можно заставить сервер стучаться во внутренние сервисы.
 */
const PRIVATE_RANGES = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/3'];

/** Меньше этого свободного места — новые серии не готовим, а кэш раздач чистим. */
const MIN_FREE = 3 * 1024 ** 3;

const SESSION_IDLE = 2 * 60_000;
/** Сессию не спрашивали дольше этого — её бросили (плеер раз в 20 с напоминает о себе). */
const ABANDONED = 30_000;
/** Сессию, с которой зритель ушёл сам, освобождаем быстрее — если её не смотрит кто-то ещё. */
const RELEASED = 8_000;
const MAX_TRANSCODES = 1;
const TORRENT_IDLE = 10 * 60_000;
/** Раздачу без трекеров (только DHT) найти бывает небыстро, особенно сразу после запуска сервера. */
const METADATA_TIMEOUT = 150_000;
const READY_TIMEOUT = 3 * 60_000;

/**
 * Решение по видео: копировать как есть или перекодировать. H.264 10-bit (Hi10P) и редкие
 * кодеки браузеры не играют вовсе, HEVC — не все (force): такое перекодируем в H.264, не выше 1080p.
 */
export function videoArgs(video: ProbeInfo['video'], force = false): string[] {
  if (!video) return [];
  if (!force && video.codec === 'hevc') return ['-c:v', 'copy', '-tag:v', 'hvc1'];
  if (!force && ((video.codec === 'h264' && !video.tenBit) || video.codec === 'av1')) return ['-c:v', 'copy'];
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-vf', 'scale=-2:min(ih\\,1080)'];
}

/** Звук: AAC стерео копируем, остальное (AC3, FLAC, DTS, 5.1) — в AAC стерео. */
export function audioArgs(audio: { codec: string; channels: number } | undefined): string[] {
  if (audio && audio.codec === 'aac' && audio.channels <= 2) return ['-c:a', 'copy'];
  return ['-c:a', 'aac', '-ac', '2', '-b:a', '192k'];
}

/**
 * Команда ffmpeg: видео из раздачи + выбранная озвучка → HLS (fMP4) в папку out. start —
 * с какой секунды: ffmpeg прыгает к ближайшему ключевому кадру, качать начало серии не нужно.
 */
export function ffmpegArgs(
  input: { video: string; audio: string | null },
  choice: AudioChoice,
  video: ProbeInfo,
  audioProbe: ProbeInfo | null,
  out: string,
  start = 0,
  transcode = false,
): string[] {
  const seek = start > 0 ? ['-ss', String(start)] : [];
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...seek, '-i', input.video];
  let audio: ProbeInfo['audio'][number] | undefined;
  if (choice.kind === 'external' && input.audio) {
    args.push(...seek, '-i', input.audio);
    audio = audioProbe?.audio[0];
    args.push('-map', '0:v:0', '-map', '1:a:0');
  } else {
    const index = choice.kind === 'embedded' ? choice.index : 0;
    audio = video.audio.find((a) => a.index === index) ?? video.audio[0];
    args.push('-map', '0:v:0', '-map', `0:a:${audio?.index ?? 0}?`);
  }
  args.push(...videoArgs(video.video, transcode), ...audioArgs(audio));
  args.push(
    '-sn',
    '-dn',
    '-map_metadata',
    '-1',
    '-max_muxing_queue_size',
    '4096',
    '-f',
    'hls',
    '-hls_time',
    '4',
    '-hls_list_size',
    '0',
    '-hls_playlist_type',
    'event',
    '-hls_segment_type',
    'fmp4',
    '-hls_fmp4_init_filename',
    'init.mp4',
    '-hls_flags',
    'independent_segments+temp_file',
    '-hls_segment_filename',
    path.join(out, 's%05d.m4s'),
    path.join(out, 'index.m3u8'),
  );
  return args;
}

/** Сводка ffprobe: длительность, видео (кодек, высота, 10 бит) и звуковые дорожки. */
export function summarizeProbe(raw: any): ProbeInfo {
  const streams: any[] = Array.isArray(raw?.streams) ? raw.streams : [];
  const v = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const duration = Number(raw?.format?.duration ?? v?.duration);
  let audioIndex = 0;
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    video: v
      ? {
          codec: String(v.codec_name ?? ''),
          height: Number(v.height) || null,
          tenBit: /10|12/.test(String(v.pix_fmt ?? '')) || /high 10/i.test(String(v.profile ?? '')),
        }
      : null,
    audio: streams
      .filter((s) => s.codec_type === 'audio')
      .map((s) => ({
        index: audioIndex++,
        codec: String(s.codec_name ?? ''),
        channels: Number(s.channels) || 2,
        title: s.tags?.title ? String(s.tags.title) : null,
        language: s.tags?.language ? String(s.tags.language) : null,
      })),
  };
}

export class TorrentStreamer {
  private options: StreamerOptions;
  private client: WebTorrent;
  private server: http.Server;
  private port = 0;
  private sessions = new Map<string, Session>();
  private probes = new Map<string, Promise<ProbeInfo>>();
  private adding = new Map<string, Promise<any>>();
  private lastUse = new Map<string, number>();
  private timer: NodeJS.Timeout;

  constructor(options: StreamerOptions) {
    this.options = options;
    this.client = new WebTorrent({
      dht: options.dht,
      lsd: false,
      natUpnp: false,
      natPmp: false,
      utp: false,
      uploadLimit: options.uploadLimit,
      blocklist: options.allowLocalPeers ? undefined : PRIVATE_RANGES,
    });
    this.client.on('error', (error: unknown) => options.log('Торрент-клиент: ошибка', error));
    // Файлы раздач для ffmpeg: только с этой машины, с поддержкой Range (перемотка, индекс .mkv в конце файла).
    this.server = http.createServer((req, res) => void this.serveFile(req, res));
    this.timer = setInterval(() => void this.cleanup(), 15_000);
    this.timer.unref();
  }

  async start(): Promise<void> {
    await rm(path.join(this.options.dir, 'hls'), { recursive: true, force: true });
    await mkdir(path.join(this.options.dir, 'data'), { recursive: true });
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this.port = (this.server.address() as { port: number }).port;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    for (const session of this.sessions.values()) this.stopSession(session);
    this.server.close();
    await new Promise<void>((resolve) => this.client.destroy(() => resolve()));
  }

  /** Метаданные раздачи (список файлов). Сами файлы при этом не качаются. */
  async metadata(magnet: string, infoHash: string): Promise<{ name: string; files: TorrentFileInfo[] }> {
    const torrent = await this.torrent(magnet, infoHash);
    return { name: torrent.name, files: torrent.files.map((f: any) => ({ path: f.path, length: f.length })) };
  }

  /** ffprobe файла раздачи: читает только заголовок (и индекс в конце .mkv). */
  probe(magnet: string, infoHash: string, file: number): Promise<ProbeInfo> {
    const key = `${infoHash}:${file}`;
    let probe = this.probes.get(key);
    if (!probe) {
      probe = this.torrent(magnet, infoHash).then(
        () =>
          new Promise<ProbeInfo>((resolve, reject) => {
            execFile(
              this.options.ffprobe ?? 'ffprobe',
              ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', this.fileUrl(infoHash, file)],
              { timeout: 2 * 60_000, maxBuffer: 8 * 1024 * 1024 },
              (error, stdout) => {
                if (error) return reject(new Error(`ffprobe не прочитал файл: ${error.message.split('\n')[0]}`));
                try {
                  resolve(summarizeProbe(JSON.parse(stdout)));
                } catch (parseError) {
                  reject(parseError);
                }
              },
            );
          }),
      );
      probe.catch(() => this.probes.delete(key));
      this.probes.set(key, probe);
    }
    return probe;
  }

  /**
   * Начать (или продолжить) готовить серию. Не ждёт: возвращает текущее состояние,
   * плеер спрашивает снова, пока не станет ready.
   */
  play(request: PlayRequest): SessionState {
    const audioKey = request.audio.kind === 'embedded' ? `e${request.audio.index}` : `x${request.audio.file}`;
    const start = Math.max(0, Math.floor(request.start ?? 0));
    const id = createHash('sha1').update(`${request.infoHash}:${request.video}:${audioKey}:${start}${request.transcode ? ':h264' : ''}`).digest('hex').slice(0, 20);
    if (request.previous && request.previous !== id) {
      const previous = this.sessions.get(request.previous);
      if (previous) previous.released = true;
    }
    let existing = this.sessions.get(id);
    // Ошибку плеер уже показал («Попробовать ещё раз») — новый запрос пробует заново.
    if (existing?.failedAt && Date.now() - existing.failedAt > 4000) {
      this.stopSession(existing);
      existing = undefined;
    }
    if (existing) {
      existing.lastAccess = Date.now();
      existing.released = false;
      this.lastUse.set(request.infoHash, Date.now());
      if (existing.state.status === 'starting') existing.state = { ...existing.state, ...this.stats(request.infoHash) };
      return existing.state;
    }
    // Лимит — на работающие ffmpeg: готовые серии лежат файлами и процессор не занимают.
    // Брошенные (озвучку или серию сменили, вкладку закрыли) уступают место сразу.
    const running = () => [...this.sessions.values()].filter((s) => s.proc !== null || s.state.status === 'starting');
    if (running().length >= this.options.maxSessions) {
      for (const session of running()) if (this.abandoned(session)) this.stopSession(session);
    }
    if (running().length >= this.options.maxSessions) {
      return { status: 'busy', message: 'Сервер сейчас готовит другие серии. Попробуйте через минуту.' };
    }
    const session: Session = {
      id,
      infoHash: request.infoHash,
      dir: path.join(this.options.dir, 'hls', id),
      proc: null,
      state: { status: 'starting', message: 'Подключаюсь к раздаче…', peers: 0, speed: 0 },
      lastAccess: Date.now(),
      transcode: false,
      released: false,
      failedAt: null,
    };
    this.sessions.set(id, session);
    this.lastUse.set(request.infoHash, Date.now());
    void this.prepare(session, request).catch((error: unknown) => {
      this.options.log('Торрент: серию не удалось подготовить', error);
      session.state = { status: 'error', message: error instanceof Error ? error.message : 'Не удалось подготовить серию' };
      session.failedAt = Date.now();
      this.stopSession(session, false);
    });
    return session.state;
  }

  /** Раздачи, которые сейчас смотрят или смотрели в последние минуты. */
  activeHashes(): Set<string> {
    const since = Date.now() - TORRENT_IDLE;
    return new Set([...this.sessions.values()].map((s) => s.infoHash).concat([...this.lastUse].filter(([, at]) => at > since).map(([hash]) => hash)));
  }

  /** Путь к файлу HLS-сессии (плейлист, init.mp4, сегменты) или null. */
  sessionFile(id: string, name: string): string | null {
    const session = this.sessions.get(id);
    if (!session || session.state.status !== 'ready' || !/^(index\.m3u8|init\.mp4|s\d{5}\.m4s)$/.test(name)) return null;
    session.lastAccess = Date.now();
    this.lastUse.set(session.infoHash, Date.now());
    return path.join(session.dir, name);
  }

  /** Плейлист для плеера: с самого начала, а не с «прямого эфира» растущего плейлиста. */
  async playlist(id: string): Promise<string | null> {
    const file = this.sessionFile(id, 'index.m3u8');
    if (!file) return null;
    const text = await readFile(file, 'utf8').catch(() => null);
    return text?.replace('#EXTM3U\n', '#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n') ?? null;
  }

  private abandoned(session: Session): boolean {
    const idle = Date.now() - session.lastAccess;
    return idle > ABANDONED || (session.released && idle > RELEASED);
  }

  private async prepare(session: Session, request: PlayRequest): Promise<void> {
    const start = Math.max(0, Math.floor(request.start ?? 0));
    await this.torrent(request.magnet, request.infoHash);
    session.state = { status: 'starting', message: 'Читаю серию…', ...this.stats(request.infoHash) };
    const video = await this.probe(request.magnet, request.infoHash, request.video);
    if (!video.video) throw new Error('В этом файле нет видео');
    const audioProbe = request.audio.kind === 'external' ? await this.probe(request.magnet, request.infoHash, request.audio.file) : null;
    if (!this.sessions.has(session.id)) return;
    // Пока серию смотрят, она лежит на диске дважды: в кэше раздачи и в сегментах HLS.
    if ((await this.freeSpace()) < MIN_FREE) {
      await this.trimCache();
      if ((await this.freeSpace()) < MIN_FREE) throw new Error('На сервере мало места на диске — серию сейчас не подготовить');
    }
    // Перекодирование (H.264 10 бит) тяжёлое: одновременно — только одно. Брошенные уступают.
    if (videoArgs(video.video, request.transcode).includes('libx264')) {
      const heavy = () => [...this.sessions.values()].filter((s) => s !== session && s.transcode && s.proc !== null);
      for (const other of heavy()) if (this.abandoned(other)) this.stopSession(other);
      if (heavy().length >= MAX_TRANSCODES) {
        session.state = { status: 'busy', message: 'Эту раздачу сервер перекодирует, а сейчас он уже занят такой. Выберите другое качество или попробуйте через пару минут.' };
        session.failedAt = Date.now();
        this.stopSession(session, false);
        return;
      }
      session.transcode = true;
    }
    await mkdir(session.dir, { recursive: true });
    const args = ffmpegArgs(
      {
        video: this.fileUrl(request.infoHash, request.video),
        audio: request.audio.kind === 'external' ? this.fileUrl(request.infoHash, request.audio.file) : null,
      },
      request.audio,
      video,
      audioProbe,
      session.dir,
      start,
      request.transcode,
    );
    session.state = { status: 'starting', message: 'Готовлю видео…', ...this.stats(request.infoHash) };
    const proc = spawn(this.options.ffmpeg ?? 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    session.proc = proc;
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
    proc.on('exit', (code) => {
      session.proc = null;
      if (code !== 0 && code !== null && session.state.status !== 'ready') {
        session.state = { status: 'error', message: `ffmpeg не смог подготовить серию: ${stderr.trim().split('\n').pop() ?? code}` };
        session.failedAt = Date.now();
      }
    });

    const started = Date.now();
    const playlist = path.join(session.dir, 'index.m3u8');
    while (this.sessions.has(session.id) && session.state.status === 'starting') {
      const text = await readFile(playlist, 'utf8').catch(() => '');
      if (text.includes('#EXTINF')) {
        // Видео, которое перекодировали, — H.264; скопированное — в своём кодеке (HEVC, AV1…).
        const codec = session.transcode ? 'h264' : video.video.codec;
        const height = session.transcode && video.video.height ? Math.min(video.video.height, 1080) : video.video.height;
        session.state = { status: 'ready', session: session.id, duration: video.duration, height, codec, offset: start };
        return;
      }
      if (Date.now() - started > READY_TIMEOUT) throw new Error('Раздача отдаёт слишком медленно: за 3 минуты не скачалось начало серии');
      session.state = { ...session.state, ...this.stats(request.infoHash) };
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  private stats(infoHash: string): { peers: number; speed: number } {
    const torrent = this.client.torrents.find((t: any) => t.infoHash === infoHash);
    return { peers: torrent?.numPeers ?? 0, speed: Math.round(torrent?.downloadSpeed ?? 0) };
  }

  private fileUrl(infoHash: string, file: number): string {
    return `http://127.0.0.1:${this.port}/${infoHash}/${file}`;
  }

  /** Раздача в клиенте: добавить по magnet (без выбора файлов) и дождаться метаданных. */
  private async torrent(magnet: string, infoHash: string): Promise<any> {
    this.lastUse.set(infoHash, Date.now());
    const existing = await this.client.get(infoHash);
    if (existing?.ready) return existing;
    let adding = this.adding.get(infoHash);
    if (!adding) {
      adding = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Не нашёл раздающих: за 2,5 минуты не пришёл даже список файлов'));
          void this.client.remove(infoHash, { destroyStore: false }).catch(() => undefined);
        }, METADATA_TIMEOUT);
        timer.unref();
        const onReady = (torrent: any) => {
          clearTimeout(timer);
          // Ничего не качаем заранее: только куски, которые читает ffmpeg.
          torrent.files.forEach((f: any) => f.deselect());
          if (torrent.pieces.length) torrent.deselect(0, torrent.pieces.length - 1);
          resolve(torrent);
        };
        if (existing) {
          existing.once('ready', () => onReady(existing));
          existing.once('error', (error: Error) => reject(error));
          return;
        }
        const torrent = this.client.add(magnet, { path: path.join(this.options.dir, 'data', infoHash), deselect: true, destroyStoreOnDestroy: false });
        torrent.once('ready', () => onReady(torrent));
        torrent.once('error', (error: Error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      adding.finally(() => this.adding.delete(infoHash)).catch(() => undefined);
      this.adding.set(infoHash, adding);
    }
    return adding;
  }

  private async serveFile(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const match = /^\/([0-9a-f]{40})\/(\d+)$/.exec(req.url ?? '');
    const torrent = match ? this.client.torrents.find((t: any) => t.infoHash === match[1]) : null;
    const file = torrent?.files?.[Number(match?.[2])];
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    this.lastUse.set(torrent.infoHash, Date.now());
    let start = 0;
    let end = file.length - 1;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(Number(range[2]), end);
      } else {
        start = Math.max(file.length - Number(range[2]), 0);
      }
      if (start > end) {
        res.writeHead(416, { 'content-range': `bytes */${file.length}` }).end();
        return;
      }
      res.writeHead(206, {
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${file.length}`,
        'content-length': end - start + 1,
        'content-type': 'application/octet-stream',
      });
    } else {
      res.writeHead(200, { 'accept-ranges': 'bytes', 'content-length': file.length, 'content-type': 'application/octet-stream' });
    }
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const iterator = file[Symbol.asyncIterator]({ start, end });
    let closed = false;
    res.on('close', () => {
      closed = true;
      void iterator.return?.();
    });
    try {
      for await (const chunk of iterator) {
        if (closed) break;
        if (!res.write(chunk)) await once(res, 'drain');
      }
      res.end();
    } catch {
      res.destroy();
    }
  }

  private stopSession(session: Session, forget = true): void {
    if (session.proc) {
      session.proc.kill('SIGTERM');
      const proc = session.proc;
      setTimeout(() => proc.exitCode === null && proc.kill('SIGKILL'), 3000).unref();
    }
    session.proc = null;
    if (forget) this.sessions.delete(session.id);
    void rm(session.dir, { recursive: true, force: true });
  }

  private async cleanup(): Promise<void> {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      const idle = session.state.status === 'error' || session.state.status === 'busy' ? 60_000 : session.released ? RELEASED * 4 : SESSION_IDLE;
      if (now - session.lastAccess > idle) this.stopSession(session);
    }
    // Раздачи, которые никто не смотрит, выключаем (данные остаются в кэше на диске).
    for (const torrent of [...this.client.torrents]) {
      const busy = [...this.sessions.values()].some((s) => s.infoHash === torrent.infoHash);
      if (!busy && now - (this.lastUse.get(torrent.infoHash) ?? 0) > TORRENT_IDLE) {
        await this.client.remove(torrent.infoHash, { destroyStore: false }).catch(() => undefined);
      }
    }
    await this.trimCache().catch((error: unknown) => this.options.log('Торрент: не удалось почистить кэш', error));
  }

  private async freeSpace(): Promise<number> {
    const info = await statfs(this.options.dir).catch(() => null);
    return info ? info.bavail * info.bsize : Number.POSITIVE_INFINITY;
  }

  /**
   * Кэш раздач больше лимита или на диске мало места — удаляем самые давно не нужные
   * раздачи (кроме тех, что смотрят сейчас).
   */
  private async trimCache(): Promise<void> {
    const root = path.join(this.options.dir, 'data');
    const dirs = await readdir(root).catch(() => [] as string[]);
    const entries = await Promise.all(dirs.map(async (name) => ({ name, size: await dirSize(path.join(root, name)), used: this.lastUse.get(name) ?? 0 })));
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    let free = await this.freeSpace();
    for (const entry of entries.sort((a, b) => a.used - b.used)) {
      if (total <= this.options.cacheBytes && free >= MIN_FREE) break;
      if (this.client.torrents.some((t: any) => t.infoHash === entry.name)) continue;
      await rm(path.join(root, entry.name), { recursive: true, force: true });
      total -= entry.size;
      free += entry.size;
    }
  }
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? await dirSize(full) : (await stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}
