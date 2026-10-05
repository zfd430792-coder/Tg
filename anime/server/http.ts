// HTTP API для фронтенда, прокси видео и раздача собранного фронтенда.

import { existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { AppConfig, ProgressInput, Release, ReleaseUserState, User } from '../shared/types.ts';
import { UpstreamError, type AniLiberty, type CatalogQuery } from './anilibria.ts';
import { validateInitData } from './auth.ts';
import type { Config } from './config.ts';
import type { Store } from './db.ts';
import { buildMaster, proxiedUrl, rewritePlaylist, type HostRegistry } from './media.ts';
import type { Notifier } from './notifier.ts';

export interface HttpDeps {
  config: Config;
  api: AniLiberty;
  store: Store;
  hosts: HostRegistry;
  notifier: Notifier | null;
  /** Есть ли у бота право писать пользователю — нужно для подписок. */
  botUsername: string | null;
}

type Query = Record<string, string | undefined>;

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const int = (value: unknown, min: number, max: number): number | undefined => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
};

const csv = (value: string | undefined, pattern: RegExp): string[] =>
  (value ?? '').split(',').map((v) => v.trim()).filter((v) => pattern.test(v)).slice(0, 20);

function releaseId(value: string): number {
  const id = int(value, 1, 10_000_000);
  if (id === undefined) throw new HttpError(400, 'Неверный id релиза');
  return id;
}

function parseProgress(body: unknown): ProgressInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const time = Number(b.time);
  const duration = Number(b.duration);
  const ordinal = Number(b.ordinal);
  if (
    !int(b.releaseId, 1, 10_000_000) ||
    typeof b.episodeId !== 'string' ||
    !/^[\w-]{1,64}$/.test(b.episodeId) ||
    !Number.isFinite(ordinal) ||
    !Number.isFinite(time) ||
    !Number.isFinite(duration) ||
    time < 0 ||
    duration < 0 ||
    duration > 6 * 3600
  ) {
    throw new HttpError(400, 'Неверные данные прогресса');
  }
  return { releaseId: Number(b.releaseId), episodeId: b.episodeId, ordinal, time: Math.min(time, duration || time), duration, watched: b.watched === true };
}

export async function buildServer(deps: HttpDeps) {
  const { config, api, store, hosts } = deps;
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  // initData проверяется на каждом запросе (это пара HMAC), а запись о
  // пользователе обновляем не чаще раза в 10 минут.
  const seen = new Map<number, number>();
  function auth(request: FastifyRequest, fallback?: unknown): User {
    if (!config.botToken) throw new HttpError(404, 'Вход через Telegram не настроен');
    const header = request.headers.authorization ?? '';
    const raw = header.startsWith('tma ') ? header.slice(4) : typeof fallback === 'string' ? fallback : '';
    const data = validateInitData(raw, config.botToken, config.initDataTtl);
    if (!data) throw new HttpError(401, 'Откройте приложение из Telegram');
    const last = seen.get(data.user.id) ?? 0;
    if (Date.now() - last > 10 * 60_000) {
      seen.set(data.user.id, Date.now());
      return store.upsertUser(data.user);
    }
    return store.getUser(data.user.id) ?? store.upsertUser(data.user);
  }

  async function loadRelease(idOrAlias: string): Promise<Release> {
    const release = await api.getRelease(idOrAlias);
    store.saveCard(release);
    return release;
  }

  async function cardFor(id: number) {
    return store.getCard(id) ?? (await loadRelease(String(id)));
  }

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof HttpError) return reply.code(error.status).send({ error: error.message });
    if (error instanceof UpstreamError) {
      const status = error.status === 404 ? 404 : 502;
      return reply.code(status).send({ error: status === 404 ? 'Не найдено' : 'Источник аниме не отвечает' });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (error as Error).message });
    request.log.error(error);
    return reply.code(502).send({ error: 'Источник аниме не отвечает' });
  });

  const cacheFor = (reply: FastifyReply, seconds: number) => reply.header('cache-control', `public, max-age=${seconds}`);

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/config', async (): Promise<AppConfig> => ({
    appName: config.appName,
    botUsername: deps.botUsername,
    appShortName: config.appShortName,
    siteUrl: config.siteUrl,
    authEnabled: Boolean(config.botToken),
  }));

  app.get('/api/latest', async (request, reply) => {
    const limit = int((request.query as Query).limit, 1, 50) ?? 24;
    cacheFor(reply, 60);
    return api.latest(limit);
  });

  app.get('/api/random', async () => {
    const card = await api.random();
    if (!card) throw new HttpError(404, 'Не найдено');
    return card;
  });

  app.get('/api/schedule', async (_request, reply) => {
    cacheFor(reply, 300);
    return api.schedule();
  });

  app.get('/api/references', async (_request, reply) => {
    cacheFor(reply, 3600);
    return api.references();
  });

  app.get('/api/search', async (request, reply) => {
    const q = ((request.query as Query).q ?? '').trim();
    if (q.length < 2) return [];
    cacheFor(reply, 120);
    return api.search(q);
  });

  app.get('/api/catalog', async (request, reply) => {
    const q = request.query as Query;
    const query: CatalogQuery = {
      page: int(q.page, 1, 1000) ?? 1,
      limit: 24,
      search: q.q?.trim().slice(0, 100) || undefined,
      genres: csv(q.genres, /^\d{1,4}$/).map(Number),
      types: csv(q.types, /^[A-Z_]{2,20}$/),
      fromYear: int(q.from, 1900, 2100),
      toYear: int(q.to, 1900, 2100),
      sorting: /^[A-Z_]{3,30}$/.test(q.sort ?? '') ? q.sort : undefined,
      ongoing: q.status === 'ongoing' ? true : q.status === 'finished' ? false : undefined,
    };
    cacheFor(reply, 120);
    return api.catalog(query);
  });

  app.get('/api/releases/:idOrAlias', async (request, reply) => {
    const { idOrAlias } = request.params as { idOrAlias: string };
    if (!/^[\w-]{1,120}$/.test(idOrAlias)) throw new HttpError(400, 'Неверный адрес релиза');
    cacheFor(reply, 60);
    return loadRelease(idOrAlias);
  });

  // Мастер-плейлист из отдельных качеств: с ним hls.js сам выбирает качество
  // под скорость сети, а пользователь может зафиксировать нужное.
  app.get('/api/master/:file', async (request, reply) => {
    const { file } = request.params as { file: string };
    const match = /^([\w-]{1,64})\.m3u8$/.exec(file);
    if (!match) throw new HttpError(404, 'Не найдено');
    const sources = await api.sourcesFor(match[1]);
    if (sources.length === 0) throw new HttpError(404, 'У серии нет видео');
    cacheFor(reply, 600);
    return reply.type('application/vnd.apple.mpegurl').send(buildMaster(sources));
  });

  app.get('/api/hls', async (request, reply) => {
    if (!config.hlsProxy) throw new HttpError(404, 'Прокси видео выключен');
    const target = (request.query as Query).u ?? '';
    if (!hosts.allows(target)) throw new HttpError(403, 'Этот адрес нельзя проксировать');

    const range = request.headers.range;
    const upstream = await fetch(target, {
      headers: range ? { range } : {},
      signal: AbortSignal.timeout(30_000),
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      throw new HttpError(upstream.status === 404 ? 404 : 502, 'Видео недоступно');
    }

    const type = upstream.headers.get('content-type') ?? '';
    if (/mpegurl/i.test(type) || new URL(target).pathname.endsWith('.m3u8')) {
      const body = rewritePlaylist(await upstream.text(), upstream.url || target, (absolute) => {
        hosts.remember(absolute);
        return proxiedUrl(absolute);
      });
      return reply.type('application/vnd.apple.mpegurl').header('cache-control', 'public, max-age=20').send(body);
    }

    reply.code(upstream.status).header('content-type', type || 'video/mp2t').header('cache-control', 'public, max-age=86400');
    for (const name of ['content-length', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(name);
      if (value) reply.header(name, value);
    }
    return reply.send(upstream.body ? Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream) : '');
  });

  // ---- Данные пользователя (только из Telegram) ----

  app.get('/api/me', async (request) => auth(request));

  app.patch('/api/me', async (request) => {
    const user = auth(request);
    const body = (request.body ?? {}) as { notify?: unknown };
    if (typeof body.notify === 'boolean') store.setNotify(user.id, body.notify);
    return store.getUser(user.id);
  });

  app.get('/api/me/releases/:id', async (request): Promise<ReleaseUserState> => {
    const user = auth(request);
    const id = releaseId((request.params as { id: string }).id);
    return { ...store.releaseFlags(user.id, id), progress: store.progress(user.id, id) };
  });

  app.get('/api/me/favorites', async (request) => store.favorites(auth(request).id));

  app.put('/api/me/favorites/:id', async (request) => {
    const user = auth(request);
    const id = releaseId((request.params as { id: string }).id);
    await cardFor(id);
    store.setFavorite(user.id, id, true);
    return { ok: true };
  });

  app.delete('/api/me/favorites/:id', async (request) => {
    const user = auth(request);
    store.setFavorite(user.id, releaseId((request.params as { id: string }).id), false);
    return { ok: true };
  });

  app.get('/api/me/subscriptions', async (request) => store.subscriptions(auth(request).id));

  app.put('/api/me/subscriptions/:id', async (request) => {
    const user = auth(request);
    const id = releaseId((request.params as { id: string }).id);
    const release = await loadRelease(String(id));
    deps.notifier?.seed(release);
    store.setSubscribed(user.id, id, true);
    return { ok: true };
  });

  app.delete('/api/me/subscriptions/:id', async (request) => {
    const user = auth(request);
    store.setSubscribed(user.id, releaseId((request.params as { id: string }).id), false);
    return { ok: true };
  });

  app.get('/api/me/history', async (request) => store.history(auth(request).id));

  // sendBeacon при закрытии страницы не умеет ставить заголовки, поэтому
  // initData можно передать и в теле запроса.
  app.post('/api/me/progress', async (request) => {
    const body = (request.body ?? {}) as { initData?: unknown };
    const user = auth(request, body.initData);
    const input = parseProgress(body);
    await cardFor(input.releaseId);
    return store.saveProgress(user.id, input);
  });

  app.all('/api/*', async () => {
    throw new HttpError(404, 'Нет такого метода API');
  });

  // ---- Фронтенд ----

  if (existsSync(config.webDist)) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      cacheControl: false,
      setHeaders(res, file) {
        res.setHeader('cache-control', file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.setNotFoundHandler((request, reply) => {
      // Отсутствующий скрипт не должен подменяться index.html — иначе браузер
      // получит HTML вместо JS и упадёт с непонятной ошибкой.
      if ((request.method !== 'GET' && request.method !== 'HEAD') || request.url.startsWith('/api/') || request.url.startsWith('/assets/')) {
        return reply.code(404).send({ error: 'Не найдено' });
      }
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    });
  } else {
    app.log.warn(`Фронтенд не собран (${config.webDist}): выполните npm run build или запустите npm run dev:web`);
  }

  return app;
}
