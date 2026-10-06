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

  /** Токен Kodik (выдают по запросу на support@kodik.biz): список озвучек других студий. */
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

  dbPath: path.resolve(root, str('DB_PATH', 'data/animini.db')!),
  webDist: path.resolve(root, 'web/dist'),
};

export type Config = typeof config;
