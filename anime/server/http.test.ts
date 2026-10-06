// Проверка HTTP API целиком: сервер ходит в мок AniLiberty (dev/mock-anilibria.ts).

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Page, PlayersResponse, Release, ReleaseCard } from '../shared/types.ts';
import { AniLiberty } from './anilibria.ts';
import { signInitData } from './auth.ts';
import { config } from './config.ts';
import { Store } from './db.ts';
import { buildServer } from './http.ts';
import { HostRegistry } from './media.ts';
import { Players } from './providers/index.ts';

const TOKEN = '123456:TEST';
const root = path.resolve(import.meta.dirname, '..');

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

let mock: ChildProcess;
let app: Awaited<ReturnType<typeof buildServer>>;
let store: Store;
let mockOrigin = '';

const auth = () => ({
  authorization: `tma ${signInitData({ user: JSON.stringify({ id: 5, first_name: 'Тест' }), auth_date: String(Math.floor(Date.now() / 1000)) }, TOKEN)}`,
});

before(async () => {
  const port = await freePort();
  mock = spawn(process.execPath, ['dev/mock-anilibria.ts'], { cwd: root, env: { ...process.env, MOCK_PORT: String(port) } });
  await new Promise<void>((resolve, reject) => {
    mock.stdout!.on('data', () => resolve());
    mock.on('exit', (code) => reject(new Error(`мок завершился с кодом ${code}`)));
  });
  const origin = `http://localhost:${port}`;
  mockOrigin = origin;
  const hosts = new HostRegistry();
  const api = new AniLiberty({ apiBase: `${origin}/api/v1`, mediaBase: origin, hlsProxy: true, hosts, userAgent: 'test' });
  store = new Store(':memory:');
  app = await buildServer({
    config: { ...config, botToken: TOKEN, apiBase: `${origin}/api/v1`, mediaBase: origin, hlsProxy: true, webDist: path.join(root, 'nonexistent') },
    api,
    store,
    hosts,
    notifier: null,
    botUsername: 'animini_bot',
    players: new Players({ kodikToken: 'test-kodik', kodikApi: `${origin}/kodik-api`, log: () => undefined }),
  });
});

after(async () => {
  await app?.close();
  store?.close();
  mock?.kill();
});

describe('публичное API', () => {
  test('каталог с фильтрами и страницами', async () => {
    const res = await app.inject('/api/catalog?status=ongoing&sort=RATING_DESC&page=1');
    assert.equal(res.statusCode, 200);
    const page = res.json<Page<ReleaseCard>>();
    assert.equal(page.total, 12);
    assert.equal(page.items.length, 12);
    assert.ok(page.items.every((c) => c.isOngoing));
    assert.ok(page.items[0].poster?.startsWith('http://localhost:'));
  });

  test('поиск и релиз по алиасу', async () => {
    const found = (await app.inject(`/api/search?q=${encodeURIComponent('титан')}`)).json<ReleaseCard[]>();
    assert.equal(found[0].alias, 'attack-on-titan');
    const release = (await app.inject('/api/releases/attack-on-titan')).json<Release>();
    assert.equal(release.title, 'Атака титанов');
    assert.deepEqual(release.voices, ['Itashi', 'Hekomi']);
    const episode = release.episodes[0];
    assert.equal(episode.sources.length, 3);
    assert.ok(episode.sources.every((s) => s.url.startsWith('/api/hls?u=')), 'при HLS_PROXY ссылки идут через сервер');
    assert.deepEqual(episode.opening, { start: 5, stop: 25 });
    assert.equal(release.episodes[2].opening, null, 'пустой опенинг {start:null} превращается в null');
  });

  test('неизвестный релиз — 404, кривой адрес — 400', async () => {
    assert.equal((await app.inject('/api/releases/no-such-anime')).statusCode, 404);
    assert.equal((await app.inject('/api/releases/..%2F..%2Fetc')).statusCode, 400);
  });

  test('мастер-плейлист серии', async () => {
    const res = await app.inject('/api/master/ep-9000-1.m3u8');
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /mpegurl/);
    assert.equal(res.body.match(/EXT-X-STREAM-INF/g)?.length, 3);
  });

  test('прокси не пускает на чужие хосты', async () => {
    const res = await app.inject(`/api/hls?u=${encodeURIComponent('https://example.com/secret')}`);
    assert.equal(res.statusCode, 403);
  });

  test('прокси переписывает плейлист и отдаёт сегменты', { skip: !existsSync(path.join(root, 'dev/media/720/index.m3u8')) && 'нет dev/media — запустите dev/make-media.sh' }, async () => {
    const release = (await app.inject('/api/releases/jujutsu-kaisen')).json<Release>();
    const playlist = await app.inject(release.episodes[0].sources[1].url);
    assert.equal(playlist.statusCode, 200);
    const segment = playlist.body.split('\n').find((line) => line.startsWith('/api/hls?u='));
    assert.ok(segment, 'сегменты переписаны на /api/hls');
    const media = await app.inject(segment);
    assert.equal(media.statusCode, 200);
    assert.ok(media.rawPayload.length > 1000);
  });
});

describe('плееры', () => {
  test('AniLibria и Kodik со списком озвучек по токену', async () => {
    const res = await app.inject('/api/releases/jujutsu-kaisen/players');
    assert.equal(res.statusCode, 200);
    const { players } = res.json<PlayersResponse>();
    assert.deepEqual(players.map((p) => p.id), ['anilibria', 'kodik']);
    const kodik = players[1];
    assert.deepEqual(kodik.dubs.map((d) => d.title), ['AniDUB', 'AniLibria.TV', 'SHIZA Project', 'Субтитры']);
    assert.ok(kodik.dubs.every((d) => d.link.startsWith('http://localhost:')));
  });

  test('тайтл без серий AniLibria — только Kodik', async () => {
    const { players } = (await app.inject('/api/releases/dr-stone/players')).json<PlayersResponse>();
    assert.deepEqual(players.map((p) => p.id), ['kodik']);
    assert.equal(players[0].lastEpisode, 3);
  });

  test('неверный токен Kodik — общий плеер из ссылки AniLiberty', async () => {
    const release = (await app.inject('/api/releases/9001')).json<Release>();
    const players = await new Players({ kodikToken: 'wrong', kodikApi: `${mockOrigin}/kodik-api`, log: () => undefined }).forRelease(release);
    const kodik = players.find((p) => p.id === 'kodik');
    assert.equal(kodik?.dubs.length, 0);
    assert.match(kodik?.link ?? '', /\/kodik\/serial\/9001\/base\/720p/);
  });
});

describe('данные пользователя', () => {
  test('без initData — 401', async () => {
    assert.equal((await app.inject('/api/me')).statusCode, 401);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/me/favorites/9000' })).statusCode, 401);
  });

  test('избранное, подписка и прогресс', async () => {
    const headers = auth();
    assert.equal((await app.inject({ method: 'PUT', url: '/api/me/favorites/9000', headers })).statusCode, 200);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/me/subscriptions/9000', headers })).statusCode, 200);
    const progress = await app.inject({
      method: 'POST',
      url: '/api/me/progress',
      headers,
      payload: { releaseId: 9000, episodeId: 'ep-9000-1', ordinal: 1, time: 58, duration: 60 },
    });
    assert.equal(progress.statusCode, 200);
    assert.equal(progress.json().watched, true);

    const state = (await app.inject({ url: '/api/me/releases/9000', headers })).json();
    assert.equal(state.favorite, true);
    assert.equal(state.subscribed, true);
    assert.equal(state.progress.length, 1);

    const history = (await app.inject({ url: '/api/me/history', headers })).json();
    assert.equal(history[0].release.title, 'Магическая битва');

    const bad = await app.inject({ method: 'POST', url: '/api/me/progress', headers, payload: { releaseId: 9000, episodeId: 'x', ordinal: 1, time: -5, duration: 60 } });
    assert.equal(bad.statusCode, 400);
  });

  test('sendBeacon: initData в теле запроса', async () => {
    const initData = auth().authorization.slice(4);
    const res = await app.inject({
      method: 'POST',
      url: '/api/me/progress',
      payload: { initData, releaseId: 9000, episodeId: 'ep-9000-2', ordinal: 2, time: 30, duration: 60 },
    });
    assert.equal(res.statusCode, 200);
  });
});
