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

  notifyInterval: num('NOTIFY_INTERVAL_MIN', 10) * 60_000,

  dbPath: path.resolve(root, str('DB_PATH', 'data/animini.db')!),
  webDist: path.resolve(root, 'web/dist'),
};

export type Config = typeof config;
