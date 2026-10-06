import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { frameSrc, normalizeLink } from '../../shared/players.ts';
import type { Release } from '../../shared/types.ts';
import { Store } from '../db.ts';
import { Alloha, Collaps, Lumex } from './balancers.ts';
import { IdResolver, ShikimoriApi } from './ids.ts';
import { kodikPlayer, noIds, playerLinkKey, toDubs, type KodikResult } from './kodik.ts';

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

// ---- Балансеры по ID Кинопоиска: ответы подменяем, сеть не нужна ----


function stubFetch(routes: Record<string, (url: URL, init?: RequestInit) => unknown>) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const route = Object.keys(routes).find((prefix) => url.href.startsWith(prefix));
    if (!route) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(routes[route](url, init)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const release = { id: 1, title: 'Тайтл', shikimoriId: 777 } as Release;
const ids = (extra = {}) => ({ ...noIds(), shikimori: '777', kinopoisk: '555', ...extra });

describe('Alloha', () => {
  const seasons = [1, 2].map((season) => ({
    season,
    episodes: [1, 2, 3].map((episode) => ({ episode, translations: season === 2 && episode === 3 ? [{ id: 9 }] : [{ id: 9 }, { id: 10 }] })),
  }));

  test('озвучки с последней серией в нашем сезоне и параметры серии', async () => {
    const stub = stubFetch({
      'https://alloha.test/v2/movies/search': (url, init) => {
        assert.equal(url.searchParams.get('kp'), '555');
        assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer T');
        return { data: { iframe: '//alloha.player/?token_movie=x', translations: [{ id: 9, name: 'AniDUB' }, { id: 10, name: 'AniLibria' }], seasons } };
      },
    });
    try {
      const player = await new Alloha('T', 'https://alloha.test/v2').find(release, ids({ kpSeason: 2 }));
      assert.equal(player?.season, '2');
      assert.deepEqual(player?.dubs.map((d) => [d.title, d.lastEpisode]), [
        ['AniDUB', 3],
        ['AniLibria', 2],
      ]);
      assert.equal(player?.dubs[0].link, 'https://alloha.player/?token_movie=x&translation=9');
      assert.equal(player?.frame?.episode, 'episode');
    } finally {
      stub.restore();
    }
  });

  test('несколько сезонов, а наш неизвестен — серию выбирают в плеере', async () => {
    const stub = stubFetch({ 'https://alloha.test/': () => ({ data: { iframe: 'https://alloha.player/?x=1', translations: [], seasons } }) });
    try {
      const player = await new Alloha('T', 'https://alloha.test/v2').find(release, ids());
      assert.equal(player?.frame?.episode, null);
      assert.equal(player?.season, null);
    } finally {
      stub.restore();
    }
  });

  test('ошибка в ответе — плеера нет', async () => {
    const stub = stubFetch({ 'https://alloha.test/': () => ({ status: 'error', error_info: 'not movie' }) });
    try {
      assert.equal(await new Alloha('T', 'https://alloha.test/v2').find(release, ids()), null);
      assert.equal(await new Alloha('T', 'https://alloha.test/v2').find(release, noIds()), null, 'без ID Кинопоиска не ищем');
    } finally {
      stub.restore();
    }
  });
});

describe('Collaps и Lumex', () => {
  test('Collaps: один сезон — открываем серию, номера серий бывают строками', async () => {
    const stub = stubFetch({
      'https://collaps.test/franchise/details': (url) => {
        assert.equal(url.searchParams.get('kinopoisk_id'), '555');
        return { iframe_url: '//collaps.player/embed/kp/555', seasons: [{ season: 1, episodes: [{ episode: '1' }, { episode: '2-3' }] }] };
      },
    });
    try {
      const player = await new Collaps('T', 'https://collaps.test').find(release, ids());
      assert.equal(player?.link, 'https://collaps.player/embed/kp/555');
      assert.equal(player?.lastEpisode, 2);
      assert.equal(player?.frame?.episode, 'episode');
      assert.equal(player?.dubs.length, 0);
    } finally {
      stub.restore();
    }
  });

  test('Lumex: по токену из API, без него — прямая ссылка по ID сайта', async () => {
    const stub = stubFetch({ 'https://lumex.test/api/short': () => ({ result: true, data: [{ iframe_src: '//p.lumex.space/abc/tv-series/1' }] }) });
    try {
      const viaApi = await new Lumex('T', 'https://lumex.test/api', null).find(release, ids());
      assert.equal(viaApi?.link, 'https://p.lumex.space/abc/tv-series/1');
      assert.equal(viaApi?.frame?.episode, null);
      const direct = await new Lumex(null, 'https://lumex.test/api', 'site42').find(release, ids());
      assert.equal(direct?.link, 'https://p.lumex.space/site42?kp_id=555');
      assert.equal(stub.calls.length, 1, 'прямая ссылка — без запроса к API');
    } finally {
      stub.restore();
    }
  });
});

describe('поиск ID Кинопоиска', () => {
  test('берёт из Shikimori, кэширует в базе и не ходит туда снова', async () => {
    const store = new Store(':memory:');
    const stub = stubFetch({
      'https://shiki.test/api/graphql': () => ({ data: { animes: [{ id: '777', externalLinks: [{ kind: 'kinopoisk', url: 'https://www.kinopoisk.ru/series/4242/' }] }] } }),
    });
    try {
      const resolver = new IdResolver({ store, shikimori: new ShikimoriApi('https://shiki.test', 'test'), log: () => undefined });
      const first = await resolver.resolve(release, { ...noIds(), shikimori: '777' });
      assert.equal(first.kinopoisk, '4242');
      const second = await resolver.resolve(release, { ...noIds(), shikimori: '777' });
      assert.equal(second.kinopoisk, '4242');
      assert.equal(stub.calls.length, 1);
    } finally {
      stub.restore();
      store.close();
    }
  });

  test('ID из Kodik сразу сохраняются, Shikimori не нужен', async () => {
    const store = new Store(':memory:');
    const stub = stubFetch({});
    try {
      const resolver = new IdResolver({ store, shikimori: new ShikimoriApi('https://shiki.test', 'test'), log: () => undefined });
      const result = await resolver.resolve(release, { shikimori: '777', kinopoisk: '1', imdb: 'tt2', kpSeason: 3 });
      assert.deepEqual([result.kinopoisk, result.kpSeason], ['1', 3]);
      assert.equal(stub.calls.length, 0);
      assert.equal(store.releaseIds(1)?.kinopoisk, '1');
    } finally {
      stub.restore();
      store.close();
    }
  });
});
