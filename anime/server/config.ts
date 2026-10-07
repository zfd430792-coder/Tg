import path from 'node:path';

function str(name: string, fallback: string | null = null): string | null {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function num(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function flag(name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes((process.env[name] ?? '').toLowerCase());
}

const root = path.resolve(import.meta.dirname, '..');
const dbPath = path.resolve(root, str('DB_PATH', 'data/animini.db')!);

export const config = {
  port: num('PORT', 3000),
  host: str('HOST', '0.0.0.0')!,
  appName: str('APP_NAME', 'AniMini')!,
  /** Публичный HTTPS-адрес приложения: его открывает Mini App и он идёт в ссылки из бота. */
  siteUrl: str('SITE_URL')?.replace(/\/+$/, '') ?? null,

  botToken: str('BOT_TOKEN'),
  appShortName: str('BOT_APP_SHORT_NAME'),
  /** Сколько секунд initData из Telegram считается свежей. */
  initDataTtl: num('INIT_DATA_TTL', 7 * 24 * 3600),

  apiBase: str('ANILIBERTY_API', 'https://aniliberty.top/api/v1')!.replace(/\/+$/, ''),
  /** Откуда грузить постеры и превью: API отдаёт их относительными путями. */
  mediaBase: str('ANILIBERTY_MEDIA', 'https://aniliberty.top')!.replace(/\/+$/, ''),
  /** Пропускать видео через свой сервер — если CDN не отдаёт CORS или недоступен у зрителей. */
  hlsProxy: flag('HLS_PROXY'),
  hlsHosts: (str('HLS_HOSTS') ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),

  /** Токен Kodik (выдают по запросу на support@kodikres.com — старый kodik.biz с марта 2026 не работает): список озвучек других студий. */
  kodikToken: str('KODIK_TOKEN'),
  kodikApi: str('KODIK_API', 'https://kodik-api.com')!.replace(/\/+$/, ''),

  /** CVH (CDNVideoHub): ID издателя (data-publisher-id). Выдают после регистрации сайта. */
  cvhPublisherId: str('CVH_PUBLISHER_ID'),
  /**
   * Адрес страницы плеера CVH — отдельный поддомен, например https://player.example.com.
   * Скрипты CVH работают на нём, а не на домене приложения, поэтому не видят данные входа
   * зрителей через Telegram. Без него CVH выключен. PLAYER_URL — для разработки (http).
   */
  playerUrl: (str('PLAYER_URL') ?? (str('PLAYER_DOMAIN') ? `https://${str('PLAYER_DOMAIN')}` : null))?.replace(/\/+$/, '') ?? null,
  cvhApi: str('CVH_API', 'https://plapi.cdnvideohub.com/api/v1')!.replace(/\/+$/, ''),
  cvhSdk: str('CVH_SDK', 'https://player.cdnvideohub.com/s2/stable/video-player.umd.js')!,
  /** Alloha: токен партнёра. Тайтл ищет по ID Кинопоиска. */
  allohaToken: str('ALLOHA_TOKEN'),
  allohaApi: str('ALLOHA_API', 'https://apbugall.org/v2')!.replace(/\/+$/, ''),
  /** Где искать ID Кинопоиска по ID Shikimori, если нет токена Kodik. Пусто — не искать (в России Shikimori заблокирован). */
  shikimoriUrl: process.env.SHIKIMORI_URL === '' ? null : str('SHIKIMORI_URL', 'https://shikimori.io')!.replace(/\/+$/, ''),

  notifyInterval: num('NOTIFY_INTERVAL_MIN', 10) * 60_000,

  /**
   * Торрент-плеер: серии прямо из торрент-раздач (1080p, 4K, все озвучки раздачи), сервер
   * качает только то, что смотрят. Включён всегда; TORRENT_PLAYER=0 — выключить.
   */
  torrents: process.env.TORRENT_PLAYER?.trim() !== '0',
  /**
   * Где искать раздачи: сайты с Jackett-совместимым API (Jacred агрегирует RuTracker, Rutor,
   * Kinozal, NNM-Club и другие), через запятую. off — не искать (раздачи AniLibria всё равно будут).
   */
  torrentSearch: (process.env.TORRENT_SEARCH_URL?.trim() === 'off' ? '' : (str('TORRENT_SEARCH_URL', 'https://jac.red') ?? ''))
    .split(',')
    .map((url) => url.trim().replace(/\/+$/, ''))
    .filter(Boolean),
  torrentSearchKey: str('TORRENT_SEARCH_KEY', '')!,
  torrentDir: path.resolve(root, str('TORRENT_DIR', path.join(path.dirname(dbPath), 'torrents'))!),
  /** Сколько места на диске может занять кэш раздач, ГБ. */
  torrentCacheGb: num('TORRENT_CACHE_GB', 10),
  /** Сколько серий сервер может готовить одновременно (ffmpeg без перекодирования почти не грузит процессор). */
  torrentSessions: num('TORRENT_SESSIONS', 4),
  /** Сколько отдавать другим участникам раздачи, КБ/с. */
  torrentUploadKbps: num('TORRENT_UPLOAD_KBPS', 1000),
  /** 0 — без DHT (только трекеры и адреса из magnet), для тестов. */
  torrentDht: process.env.TORRENT_DHT !== '0',
  /** 1 — пускать участников раздачи с локальных адресов (только для тестов на одной машине). */
  torrentLocalPeers: flag('TORRENT_LOCAL_PEERS'),
  /** Пути к ffmpeg и ffprobe, если они не в PATH. */
  ffmpeg: str('TORRENT_FFMPEG', 'ffmpeg')!,
  ffprobe: str('TORRENT_FFPROBE', 'ffprobe')!,

  dbPath,
  webDist: path.resolve(root, 'web/dist'),
};

export type Config = typeof config;
