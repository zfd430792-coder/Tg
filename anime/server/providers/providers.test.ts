import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import { frameSrc, normalizeLink } from '../../shared/players.ts';
import type { Release } from '../../shared/types.ts';
import { Players } from './index.ts';
import { isKodikLink, KodikApi, kodikFallbackLink, kodikPlayer, playerLinkKey, toDubs, type KodikResult } from './kodik.ts';

const result = (id: number, title: string, type: string, last: number, extra: Partial<KodikResult> = {}): KodikResult => ({
  id: `serial-${id}`,
  type: 'anime-serial',
  link: `//kodik.info/serial/${id}/hash${id}/720p`,
  title: 'Тайтл',
  translation: { id, title, type },
  last_season: 1,
  last_episode: last,
  ...extra,
});

describe('ссылки на плееры', () => {
  test('приводит ссылки к https', () => {
    assert.equal(normalizeLink('//kodik.info/serial/1/h/720p'), 'https://kodik.info/serial/1/h/720p');
    assert.equal(normalizeLink('http://kodik.cc/serial/1/h/720p'), 'https://kodik.cc/serial/1/h/720p');
    assert.equal(normalizeLink('//localhost:4010/kodik/x'), 'http://localhost:4010/kodik/x');
    assert.equal(normalizeLink('javascript:alert(1)'), null);
    assert.equal(normalizeLink(''), null);
  });

  test('открывает серию и прячет или показывает меню озвучек', () => {
    const params = { season: 'season', episode: 'episode', hideDubs: { translations: 'false' }, showDubs: ['translations', 'hide_selectors'] };
    const own = frameSrc('https://kodik.info/serial/1/h/720p?translations=false', { params, season: '4', episode: 3 });
    assert.equal(own, 'https://kodik.info/serial/1/h/720p?season=4&episode=3', 'общий плеер: меню озвучек возвращаем');
    const ours = frameSrc('https://kodik.info/serial/1/h/720p', { params, season: '1', episode: 2, hideDubs: true });
    assert.equal(ours, 'https://kodik.info/serial/1/h/720p?translations=false&season=1&episode=2');
    const noSeason = frameSrc('https://kodik.info/serial/1/h/720p', { params: { ...params, season: null }, season: null, episode: 5 });
    assert.equal(noSeason, 'https://kodik.info/serial/1/h/720p?episode=5');
  });

  test('external_player встраиваем, только если это Kodik', () => {
    assert.equal(isKodikLink('https://kodik.info/serial/1/h/720p'), true);
    assert.equal(isKodikLink('https://kodikplayer.com/find-player?shikimoriID=1'), true);
    assert.equal(isKodikLink('https://evil.example/kodik.info'), false);
    assert.equal(isKodikLink('https://kodik.info.evil.example/x'), false);
    const base = { shikimoriId: 5 } as Release;
    assert.equal(kodikFallbackLink({ ...base, externalPlayer: 'https://evil.example/player' }), 'https://kodikplayer.com/find-player?shikimoriID=5');
    assert.equal(kodikFallbackLink({ ...base, externalPlayer: 'https://kodik.info/serial/1/h/720p' }), 'https://kodik.info/serial/1/h/720p');
  });

  test('ключ для поиска Kodik по ссылке — без схемы и параметров', () => {
    assert.equal(playerLinkKey('https://kodik.info/serial/48654/abc/720p?translations=false'), 'kodik.info/serial/48654/abc/720p');
    assert.equal(playerLinkKey('//kodik.info/serial/1/a/720p'), 'kodik.info/serial/1/a/720p');
  });
});

describe('озвучки Kodik', () => {
  test('по одной на перевод, сначала озвучки с большим числом серий, субтитры в конце', () => {
    const dubs = toDubs([
      result(869, 'Субтитры', 'subtitles', 12),
      result(610, 'AniLibria.TV', 'voice', 7),
      result(609, 'AniDUB', 'voice', 9),
      result(609, 'AniDUB', 'voice', 10, { link: '//kodik.info/serial/609/newer/720p' }),
      { ...result(1, 'Без ссылки', 'voice', 3), link: '' },
    ]);
    assert.deepEqual(
      dubs.map((d) => [d.title, d.lastEpisode, d.type]),
      [
        ['AniDUB', 10, 'voice'],
        ['AniLibria.TV', 7, 'voice'],
        ['Субтитры', 12, 'subtitles'],
      ],
    );
    assert.equal(dubs[0].link, 'https://kodik.info/serial/609/newer/720p');
    assert.equal(dubs[0].id, 'kodik:609');
    assert.equal(dubs[0].season, '1');
  });

  test('сезон берётся из ключей seasons, фильм — одна серия', () => {
    const [serial] = toDubs([result(1, 'A', 'voice', 5, { last_season: undefined, seasons: { '4': {} } })]);
    assert.equal(serial.season, '4');
    const [movie] = toDubs([{ ...result(2, 'B', 'voice', 0), type: 'anime', last_episode: undefined, last_season: undefined }]);
    assert.equal(movie.lastEpisode, 1);
  });

  test('без токена — общий плеер по ссылке AniLiberty, без неё — ничего', () => {
    const shared = kodikPlayer([], 'https://kodik.info/serial/1/h/720p?translations=false');
    assert.equal(shared?.link, 'https://kodik.info/serial/1/h/720p?translations=false');
    assert.equal(shared?.frame?.season, null);
    assert.equal(shared?.frame?.episode, 'episode');
    assert.equal(kodikPlayer([], null), null);
    const withDubs = kodikPlayer(toDubs([result(609, 'AniDUB', 'voice', 9)]), null);
    assert.equal(withDubs?.lastEpisode, 9);
    assert.equal(withDubs?.link, null);
  });
});

// ---- API Kodik и кэш плееров: ответы подменяем, сеть не нужна ----

function stubFetch(routes: Record<string, (url: URL, body: URLSearchParams) => unknown>) {
  const calls: URLSearchParams[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = new URLSearchParams(String(init?.body ?? ''));
    calls.push(body);
    const route = Object.keys(routes).find((prefix) => url.href.startsWith(prefix));
    if (!route) return new Response('not found', { status: 404 });
    const answer = routes[route](url, body);
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

describe('API Kodik', () => {
  test('переводы ищем по ID Shikimori, а без него — запись по ссылке из AniLiberty', async () => {
    const stub = stubFetch({
      'https://kodik.test/search': (_url, body) => {
        if (body.get('token') !== 'T') return { error: 'Отсутствует или неверный токен' };
        if (body.get('player_link')) return { results: [result(1, 'AniLibria.TV', 'voice', 5, { shikimori_id: '888' })] };
        if (body.get('shikimori_id') === '888') return { results: [result(609, 'AniDUB', 'voice', 6), result(610, 'AniLibria.TV', 'voice', 5)] };
        return { results: [] };
      },
    });
    try {
      const api = new KodikApi('T', 'https://kodik.test');
      const title = { id: 1, title: 'Тайтл', shikimoriId: 888, externalPlayer: null } as unknown as Release;
      assert.equal((await api.translations(title)).length, 2);
      const noShikimori = { ...title, shikimoriId: null, externalPlayer: 'https://kodik.info/serial/1/h/720p' } as unknown as Release;
      assert.deepEqual(toDubs(await api.translations(noShikimori)).map((d) => d.title), ['AniDUB', 'AniLibria.TV']);
      assert.equal(stub.calls[1].get('player_link'), 'kodik.info/serial/1/h/720p');
      await assert.rejects(new KodikApi('wrong', 'https://kodik.test').search({ title: 'x' }), /неверный токен/);
    } finally {
      stub.restore();
    }
  });
});

describe('кэш плееров', () => {
  test('неполный список (Kodik не ответил) держим минуту, полный — 20 минут', async () => {
    let calls = 0;
    let up = false;
    const stub = stubFetch({
      'https://kodik.test/search': () => {
        calls++;
        return up ? { results: [result(609, 'AniDUB', 'voice', 3)] } : new Response('down', { status: 502 });
      },
    });
    mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    try {
      const players = new Players({ kodikToken: 'T', kodikApi: 'https://kodik.test', log: () => undefined });
      const title = { id: 5, title: 'Тайтл', shikimoriId: 777, externalPlayer: null, episodes: [] } as unknown as Release;
      assert.equal((await players.forRelease(title)).length, 1, 'общий плеер Kodik по ID Shikimori');
      await players.forRelease(title);
      assert.equal(calls, 1, 'в течение минуты — из кэша');
      up = true;
      mock.timers.tick(61_000);
      const full = await players.forRelease(title);
      assert.equal(calls, 2);
      assert.equal(full[0].dubs.length, 1);
      mock.timers.tick(10 * 60_000);
      await players.forRelease(title);
      assert.equal(calls, 2, 'полный список ещё в кэше');
    } finally {
      mock.timers.reset();
      stub.restore();
    }
  });
});
