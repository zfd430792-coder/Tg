// Точка входа: HTTP API + фронтенд, бот и проверка новых серий в одном процессе.

import { AniLiberty } from './anilibria.ts';
import { createBot } from './bot.ts';
import { config } from './config.ts';
import { Store } from './db.ts';
import { buildServer } from './http.ts';
import { HostRegistry } from './media.ts';
import { Notifier } from './notifier.ts';
import { Players } from './providers/index.ts';

const hosts = new HostRegistry(config.hlsHosts);
const api = new AniLiberty({
  apiBase: config.apiBase,
  mediaBase: config.mediaBase,
  hlsProxy: config.hlsProxy,
  hosts,
  userAgent: `${config.appName}/0.1 (+${config.siteUrl ?? 'local'})`,
});
const store = new Store(config.dbPath);
const log = (message: string, error?: unknown) => console.error(`[${new Date().toISOString()}] ${message}`, error ?? '');

let telegram: ReturnType<typeof createBot> | null = null;
let botUsername: string | null = null;
let notifier: Notifier | null = null;

if (config.botToken && config.siteUrl?.startsWith('https://')) {
  telegram = createBot({ token: config.botToken, siteUrl: config.siteUrl, appName: config.appName, api, log });
  try {
    await telegram.bot.init();
    botUsername = telegram.bot.botInfo.username;
    await telegram.setup();
  } catch (error) {
    log('Не удалось подключиться к Telegram — проверьте BOT_TOKEN', error);
    telegram = null;
  }
} else if (config.botToken) {
  log('BOT_TOKEN задан, но SITE_URL не https:// — Mini App работает только по HTTPS, бот не запущен');
}

if (telegram) {
  const sender = telegram;
  notifier = new Notifier({
    store,
    latest: () => api.latestFresh(50),
    release: async (id) => {
      const release = await api.getRelease(String(id), true);
      store.saveCard(release);
      return release;
    },
    send: (userId, release, episodes) => sender.notify(userId, release, episodes),
    log,
  });
  notifier.start(config.notifyInterval);
}

// Плеер CVH работает только на отдельном поддомене: на домене приложения его скрипты
// видели бы данные входа зрителей.
if (config.playerUrl && config.siteUrl && new URL(config.playerUrl).origin === new URL(config.siteUrl).origin) {
  console.warn('PLAYER_DOMAIN совпадает с доменом сайта — нужен отдельный поддомен, например player.<домен>. CVH выключен.');
  config.playerUrl = null;
}
if (config.cvhPublisherId && !config.playerUrl) {
  console.warn('CVH выключен: для его плеера нужен отдельный поддомен — задайте PLAYER_DOMAIN (например, player.<ваш домен>).');
}
const players = new Players({
  kodikToken: config.kodikToken,
  kodikApi: config.kodikApi,
  cvhPublisherId: config.cvhPublisherId,
  cvhApi: config.cvhApi,
  allohaToken: config.allohaToken,
  allohaApi: config.allohaApi,
  playerUrl: config.playerUrl,
  shikimoriUrl: config.shikimoriUrl,
  userAgent: `${config.appName}/0.1 (+${config.siteUrl ?? 'local'})`,
  store,
  log,
});
console.log(`Плееры: ${players.enabled.join(', ')}`);
const app = await buildServer({ config, api, store, hosts, notifier, botUsername, players });
await app.listen({ port: config.port, host: config.host });

if (telegram) {
  // Long polling: вебхук не нужен, бот сам забирает обновления у Telegram.
  telegram.bot.start({ drop_pending_updates: true }).catch((error) => log('Бот остановился с ошибкой', error));
  app.log.info(`Бот @${botUsername} запущен`);
}

async function shutdown(signal: string) {
  app.log.info(`${signal}: останавливаюсь`);
  notifier?.stop();
  await telegram?.bot.stop().catch(() => undefined);
  await app.close();
  store.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
