import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import { frameSrc, normalizeLink } from '../../shared/players.ts';
import type { Release } from '../../shared/types.ts';
import { Store } from '../db.ts';
import { Alloha, Cvh, cvhPage, pickAllohaItem, pickSeason } from './balancers.ts';
import { IdResolver, seasonFromTitle, ShikimoriApi } from './ids.ts';
import { Players } from './index.ts';
import { idsFrom, isKodikLink, KodikApi, kodikFallbackLink, kodikPlayer, noIds, playerLinkKey, qualityOf, toDubs, type KodikResult } from './kodik.ts';

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

// ---- Ответы API подменяем, сеть не нужна ----

function stubFetch(routes: Record<string, (url: URL, init?: RequestInit) => unknown>) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const route = Object.keys(routes).find((prefix) => url.href.startsWith(prefix));
    if (!route) return new Response('not found', { status: 404 });
    const answer = routes[route](url, init);
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const form = (init?: RequestInit) => new URLSearchParams(String(init?.body ?? ''));
const release = { id: 1, title: 'Тайтл', shikimoriId: 777, externalPlayer: null, episodes: [] } as unknown as Release;
const ids = (extra = {}) => ({ ...noIds(), shikimori: '777', kinopoisk: '555', ...extra });

describe('API Kodik', () => {
  test('переводы ищем по ID Shikimori, а без него — запись по ссылке из AniLiberty', async () => {
    const stub = stubFetch({
      'https://kodik.test/search': (_url, init) => {
        const body = form(init);
        if (body.get('token') !== 'T') return { error: 'Отсутствует или неверный токен' };
        if (body.get('player_link')) return { results: [result(1, 'AniLibria.TV', 'voice', 5, { shikimori_id: '888' })] };
        if (body.get('shikimori_id') === '888') return { results: [result(609, 'AniDUB', 'voice', 6), result(610, 'AniLibria.TV', 'voice', 5)] };
        return { results: [] };
      },
    });
    try {
      const api = new KodikApi('T', 'https://kodik.test');
      const title = { ...release, shikimoriId: 888 } as Release;
      assert.equal((await api.translations(title)).length, 2);
      const noShikimori = { ...release, shikimoriId: null, externalPlayer: 'https://kodik.info/serial/1/h/720p' } as unknown as Release;
      assert.deepEqual(toDubs(await api.translations(noShikimori)).map((d) => d.title), ['AniDUB', 'AniLibria.TV']);
      assert.equal(form(stub.calls[1].init).get('player_link'), 'kodik.info/serial/1/h/720p');
      await assert.rejects(new KodikApi('wrong', 'https://kodik.test').search({ title: 'x' }), /неверный токен/);
    } finally {
      stub.restore();
    }
  });

  test('ID Кинопоиска, IMDb и сезон — по большинству записей; качество — из строки', () => {
    const results = [
      result(1, 'A', 'voice', 5, { kinopoisk_id: '42', imdb_id: 'tt1', last_season: 2 }),
      result(2, 'B', 'voice', 5, { kinopoisk_id: '42', imdb_id: 'tt1', last_season: 2 }),
      result(3, 'C', 'voice', 5, { kinopoisk_id: '7', last_season: 1 }),
    ];
    assert.deepEqual(idsFrom(results, '777'), { shikimori: '777', kinopoisk: '42', imdb: 'tt1', kpSeason: 2 });
    assert.equal(qualityOf('WEB-DLRip 720p'), 720);
    assert.equal(qualityOf('BDRip 1080p'), 1080);
    assert.equal(qualityOf('4K UHD'), 2160);
    assert.equal(qualityOf('DVDRip'), null);
    assert.equal(toDubs([result(1, 'A', 'voice', 5, { quality: 'BDRip 720p' })])[0].quality, 720);
  });
});

describe('Alloha', () => {
  const seasons = [1, 2].map((season) => ({
    season,
    episodes: [1, 2, 3].map((episode) => ({ episode, translations: season === 2 && episode === 3 ? [{ id: 9 }] : [{ id: 9 }, { id: 10 }] })),
  }));

  test('новый API (v2): озвучки с последней серией в нашем сезоне, качество и параметры серии', async () => {
    const stub = stubFetch({
      'https://alloha.test/v2/movies/search': (url, init) => {
        assert.equal(url.searchParams.get('kp'), '555');
        assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer T');
        return {
          data: {
            iframe: '//alloha.player/?token_movie=x',
            translations: [
              { id: 9, name: 'AniDUB', resolutions: [1080, 720] },
              { id: 10, name: 'AniLibria', uhd: true },
              { id: 11, name: 'Нет в нашем сезоне', quality: 'WEB-DL 720p' },
            ],
            seasons,
          },
        };
      },
    });
    try {
      const player = await new Alloha('T', 'https://alloha.test/v2').find(release, ids({ kpSeason: 2 }));
      assert.equal(player?.season, '2');
      assert.deepEqual(player?.dubs.map((d) => [d.title, d.lastEpisode, d.quality]), [
        ['AniDUB', 3, 1080],
        ['AniLibria', 2, 2160],
      ]);
      assert.equal(player?.dubs[0].link, 'https://alloha.player/?token_movie=x&translation=9');
      assert.equal(player?.frame?.episode, 'episode');
      assert.equal(player?.events, null);
    } finally {
      stub.restore();
    }
  });

  test('несколько сезонов, а наш неизвестен — серию выбирают в плеере; нужного сезона нет — плеера нет', async () => {
    const stub = stubFetch({ 'https://alloha.test/': () => ({ data: { iframe: 'https://alloha.player/?x=1', translations: [], seasons } }) });
    try {
      const unknown = await new Alloha('T', 'https://alloha.test/v2').find(release, ids());
      assert.equal(unknown?.frame?.episode, null);
      assert.equal(unknown?.season, null);
      assert.equal(await new Alloha('T', 'https://alloha.test/v2').find(release, ids({ kpSeason: 3 })), null);
    } finally {
      stub.restore();
    }
  });

  test('ошибка в ответе — плеера нет', async () => {
    const stub = stubFetch({ 'https://alloha.test/': () => ({ status: 'error', error_info: 'not movie' }) });
    try {
      assert.equal(await new Alloha('T', 'https://alloha.test/v2').find(release, ids()), null);
      assert.equal(await new Alloha('T', 'https://alloha.test').find(release, noIds()), null, 'по названию тоже не нашлось');
    } finally {
      stub.restore();
    }
  });

  // Как отвечает классический API: сезоны, серии и озвучки — объекты с номером в ключе.
  const translation = (name: string, quality: string) => ({ name, quality, iframe: 'https://alloha.player/?token_movie=x', adv: false });
  const episode = (n: number, dubs: string[]) => ({
    episode: n,
    iframe: 'https://alloha.player/?token_movie=x',
    translation: Object.fromEntries(dubs.map((id) => [id, { translation: `Озвучка ${id}`, quality: 'WEB-DL' }])),
  });
  const full = {
    name: 'Магическая битва',
    original_name: 'Jujutsu Kaisen',
    year: 2020,
    category: 4,
    id_kp: 1312345,
    iframe: 'https://alloha.player/?token_movie=x',
    seasons_count: 2,
    translation_iframe: { 9: translation('AniDUB', 'WEB-DL 1080p'), 10: translation('Dream Cast', 'WEB-DL'), 79: translation('Субтитры', 'WEB-DL') },
    seasons: {
      1: { season: 1, episodes: { 1: episode(1, ['9', '79']), 2: episode(2, ['9']) } },
      2: { season: 2, episodes: { 1: episode(1, ['9', '10']), 2: episode(2, ['10']), 3: episode(3, ['10']) } },
    },
  };

  test('классический API: токен в адресе, сезоны и озвучки объектами', async () => {
    const stub = stubFetch({
      'https://alloha.test/': (url, init) => {
        assert.equal(url.pathname, '/');
        assert.equal(url.searchParams.get('token'), 'T');
        assert.equal(url.searchParams.get('kp'), '555');
        assert.equal((init?.headers as Record<string, string>).authorization, undefined, 'токен не в заголовке');
        return { status: 'success', data: full };
      },
    });
    try {
      const player = await new Alloha('T', 'https://alloha.test').find(release, ids({ kpSeason: 1 }));
      assert.equal(player?.season, '1');
      assert.deepEqual(player?.dubs.map((d) => [d.title, d.lastEpisode, d.type, d.quality]), [
        ['AniDUB', 2, 'voice', 1080],
        ['Субтитры', 1, 'subtitles', null],
      ]);
      assert.equal(player?.dubs[0].link, 'https://alloha.player/?token_movie=x&translation=9');
      assert.equal(player?.lastEpisode, 2);
    } finally {
      stub.restore();
    }
  });

  test('без ID Кинопоиска ищет по названию и берёт полную запись по её ID', async () => {
    const season2 = {
      ...release,
      id: 2,
      title: 'Магическая битва 2',
      titleEn: 'Jujutsu Kaisen 2nd Season',
      year: 2023,
      type: 'ТВ',
      episodesTotal: 23,
    } as Release;
    const names: string[] = [];
    const stub = stubFetch({
      'https://alloha.test/': (url) => {
        assert.equal(url.searchParams.get('token'), 'T');
        const name = url.searchParams.get('name');
        if (name) {
          names.push(name);
          assert.equal(url.searchParams.get('list'), '1');
          return {
            status: 'success',
            data: [
              { name: 'Магическая битва', year: 1995, category: 'Сериал', category_id: 4, id_kp: 1 },
              { name: 'Магическая битва: Фильм', year: 2021, category: 'Мультфильм', category_id: 2, id_kp: 2 },
              { name: 'Магическая битва', original_name: 'Jujutsu Kaisen', year: 2020, category: 'Сериал', category_id: 4, id_kp: 1312345, last_season: 2 },
            ],
          };
        }
        assert.equal(url.searchParams.get('kp'), '1312345', 'полная запись — по ID из списка');
        return { status: 'success', data: full };
      },
    });
    try {
      const player = await new Alloha('T', 'https://alloha.test').find(season2, noIds());
      assert.deepEqual(names, ['Магическая битва'], 'название без номера сезона, до первого совпадения');
      assert.equal(player?.season, '2', 'сезон — из названия тайтла');
      assert.deepEqual(player?.dubs.map((d) => [d.title, d.lastEpisode]), [
        ['Dream Cast', 3],
        ['AniDUB', 1],
      ]);
      assert.equal(player?.frame?.episode, 'episode');
    } finally {
      stub.restore();
    }
  });

  test('по названию: совпасть должны имя, год и фильм или сериал; аниме — в приоритете', () => {
    const tv = { ...release, title: 'Атака титанов', titleEn: 'Shingeki no Kyojin', year: 2013, type: 'ТВ' } as Release;
    const item = (extra: Record<string, unknown>) => ({ name: 'Атака титанов', year: 2013, category_id: 4, ...extra });
    assert.equal(pickAllohaItem([item({ year: 2015 })], tv), null, 'другой год');
    assert.equal(pickAllohaItem([item({ category_id: 1 })], tv), null, 'фильм, а нужен сериал');
    assert.equal(pickAllohaItem([item({ name: 'Атака на титанов' })], tv), null, 'другое название');
    assert.equal(pickAllohaItem([item({ name: 'Вторжение гигантов', original_name: 'Shingeki no kyojin', id_kp: 7 })], tv)?.id_kp, 7, 'по оригинальному названию');
    const anime = item({ category: 'Аниме', category_id: 5, id_kp: 5 });
    assert.equal(pickAllohaItem([item({ id_kp: 4 }), anime], tv)?.id_kp, 5);
    // Категория по ID — число в category.
    assert.equal(pickAllohaItem([{ name: 'Атака титанов', year: 2013, category: 1 }], tv), null);

    const movie = { ...release, title: 'Магическая битва 0', titleEn: 'Jujutsu Kaisen 0', year: 2021, type: 'Фильм' } as Release;
    const found = pickAllohaItem(
      [
        { name: 'Магическая битва', year: 2020, category_id: 4, last_season: 2, id_kp: 1 },
        { name: 'Магическая битва 0', year: 2021, category_id: 2, id_kp: 2 },
      ],
      movie,
    );
    assert.equal(found?.id_kp, 2, 'для фильма сериал не берём');
  });
});

describe('CVH', () => {
  const item = (voiceStudio: string, episode: number, season = 1) => ({ voiceStudio, season, episode });

  test('аниме — по ID Shikimori, озвучки с числом серий, плеер на поддомене', async () => {
    const stub = stubFetch({
      'https://cvh.test/api/v1/player/sv/playlist': (url, init) => {
        assert.deepEqual([url.searchParams.get('pub'), url.searchParams.get('aggr'), url.searchParams.get('id')], ['P', 'mali', '777']);
        assert.equal((init?.headers as Record<string, string>).referer, 'https://player.anime.example/');
        return { isSerial: true, items: [item('AniDub Online', 1), item('AniDub Online', 2), item('Dream Cast', 1), item('Субтитры', 3)] };
      },
    });
    try {
      const player = await new Cvh('P', 'https://cvh.test/api/v1', 'https://player.anime.example').find(release, ids());
      assert.equal(player?.link, 'https://player.anime.example/embed/cvh?aggr=mali&id=777');
      assert.deepEqual(player?.dubs.map((d) => [d.title, d.lastEpisode]), [
        ['AniDub Online', 2],
        ['Dream Cast', 1],
        ['Субтитры', 3],
      ]);
      assert.equal(player?.lastEpisode, 3);
      assert.equal(player?.events, 'kodik');
      const src = frameSrc(player!.dubs[1].link, { params: player!.frame!, season: player!.season, episode: 1, hideDubs: true });
      assert.equal(src, 'https://player.anime.example/embed/cvh?aggr=mali&id=777&voice=Dream+Cast&only=1&season=1&episode=1');
    } finally {
      stub.restore();
    }
  });

  test('204 — тайтла нет; 403 — плеер без списка озвучек; без ID Shikimori — по Кинопоиску и сезону', async () => {
    let status = 204;
    const stub = stubFetch({
      'https://cvh.test/': (url) => {
        if (status !== 200) return new Response(status === 204 ? null : 'forbidden', { status });
        assert.equal(url.searchParams.get('aggr'), 'kp');
        return { isSerial: true, items: [item('A', 1, 1), item('A', 12, 1), item('A', 5, 2)] };
      },
    });
    try {
      const cvh = new Cvh('P', 'https://cvh.test/api/v1', 'https://player.test');
      assert.equal(await cvh.find(release, ids()), null);
      status = 403;
      const forbidden = await cvh.find(release, ids());
      assert.deepEqual([forbidden?.dubs.length, forbidden?.frame?.episode], [0, 'episode']);
      status = 200;
      const second = await cvh.find(release, ids({ shikimori: null, kpSeason: 2 }));
      assert.deepEqual([second?.season, second?.lastEpisode, second?.frame?.episode], ['2', 5, 'episode']);
      const unknown = await cvh.find(release, ids({ shikimori: null }));
      assert.equal(unknown?.frame?.episode, null, 'сезонов несколько, наш неизвестен — серию выбирают в плеере');
      assert.equal(await cvh.find(release, ids({ shikimori: null, kpSeason: 3 })), null);
    } finally {
      stub.restore();
    }
  });

  test('страница CVH: проверенные атрибуты и события приложению в формате Kodik', () => {
    const page = cvhPage({ aggr: 'mali', id: '777', season: '1', episode: '3', voice: 'Dream "Cast"', only: '1' }, 'P', 'https://sdk.test/v.js?a=1&b=2', 'https://anime.example');
    assert.ok(
      page?.includes(
        '<video-player data-publisher-id="P" data-aggregator="mali" data-title-id="777" ident="cvh-mali-777" season="1" episode="3" priority-voice="Dream &quot;Cast&quot;" only-voice="Dream &quot;Cast&quot;">',
      ),
    );
    assert.ok(page?.includes("send('kodik_player_time_update'"));
    assert.ok(page?.includes('parent.postMessage({ key: key, value: value }, "https://anime.example")'), 'события — только приложению');
    assert.ok(page?.includes('src="https://sdk.test/v.js?a=1&amp;b=2"'));
    const free = cvhPage({ aggr: 'mali', id: '1', voice: 'AniDub' }, 'P', 'https://sdk.test/v.js', null);
    assert.ok(free?.includes('priority-voice="AniDub"') && !free.includes('only-voice'));
    assert.ok(free?.includes('}, "*")'), 'адрес приложения неизвестен — любому родителю');
    assert.equal(cvhPage({ aggr: 'imdb', id: '1' }, 'P', 'x', null), null);
    assert.equal(cvhPage({ aggr: 'kp', id: '1"><script>' }, 'P', 'x', null), null);
    const loose = cvhPage({ aggr: 'kp', id: '1', season: '1"', episode: 'x' }, 'P', 'x', null);
    assert.ok(loose && !loose.includes(' season=') && !loose.includes(' episode='));
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
      const found = await resolver.resolve(release, { shikimori: '777', kinopoisk: '1', imdb: 'tt2', kpSeason: 3 });
      assert.deepEqual([found.kinopoisk, found.kpSeason], ['1', 3]);
      assert.equal(stub.calls.length, 0);
      assert.equal(store.releaseIds(1)?.kinopoisk, '1');
    } finally {
      stub.restore();
      store.close();
    }
  });

  test('найденный ID перепроверяется через 30 дней, а при ошибке Shikimori остаётся старый', async () => {
    const store = new Store(':memory:');
    let fail = false;
    const stub = stubFetch({
      'https://shiki.test/api/graphql': () =>
        fail ? new Response('busy', { status: 503 }) : { data: { animes: [{ externalLinks: [{ kind: 'kinopoisk', url: 'https://www.kinopoisk.ru/film/99/' }] }] } },
    });
    mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
    try {
      const title = { ...release, title: 'Тайтл 2 сезон' } as Release;
      const resolver = new IdResolver({ store, shikimori: new ShikimoriApi('https://shiki.test', 'test'), log: () => undefined });
      assert.deepEqual([(await resolver.resolve(title, noIds())).kinopoisk, store.releaseIds(1)?.kpSeason], ['99', 2], 'сезон — из названия');
      mock.timers.tick(31 * 86_400_000);
      fail = true;
      assert.equal((await resolver.resolve(title, noIds())).kinopoisk, '99');
      assert.equal(stub.calls.length, 2, 'через 30 дней спросили снова');
    } finally {
      mock.timers.reset();
      stub.restore();
      store.close();
    }
  });

  test('Shikimori: только обычный Кинопоиск, после ошибки пауза', async () => {
    let fail = false;
    const stub = stubFetch({
      'https://shiki.test/api/graphql': () =>
        fail
          ? new Response('busy', { status: 429 })
          : {
              data: {
                animes: [
                  {
                    externalLinks: [
                      { kind: 'kinopoisk_hd', url: 'https://hd.kinopoisk.ru/film/4a8b9c' },
                      { kind: 'kinopoisk', url: 'https://www.kinopoisk.ru/series/1234567/' },
                    ],
                  },
                ],
              },
            },
    });
    try {
      const api = new ShikimoriApi('https://shiki.test', 'test');
      assert.equal(await api.kinopoiskId('1'), '1234567');
      fail = true;
      await assert.rejects(api.kinopoiskId('2'));
      fail = false;
      await assert.rejects(api.kinopoiskId('3'), /позже/);
      assert.equal(stub.calls.length, 2, 'во время паузы запросов нет');
    } finally {
      stub.restore();
    }
  });

  test('номер сезона из названия и выбор сезона у балансера', () => {
    const title = (ru: string, en: string | null = null) => ({ title: ru, titleEn: en }) as Release;
    assert.equal(seasonFromTitle(title('Магическая битва 2')), null, 'просто цифра — не сезон');
    assert.equal(seasonFromTitle(title('Тайтл 3 сезон')), 3);
    assert.equal(seasonFromTitle(title('Тайтл ТВ-2')), 2);
    assert.equal(seasonFromTitle(title('Тайтл', 'Title Season 4')), 4);
    assert.equal(seasonFromTitle(title('Тайтл', 'Title II')), 2);
    const seasons = (...numbers: number[]) => numbers.map((season) => ({ season }));
    assert.equal(pickSeason(seasons(1, 2), 2), 2);
    assert.equal(pickSeason(seasons(1), 3), 'missing', 'единственный сезон 1, а нужен 3');
    assert.equal(pickSeason(seasons(1), null), 1);
    assert.equal(pickSeason(seasons(1, 2), null), null);
  });
});

describe('список плееров', () => {
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
      assert.equal((await players.forRelease(release)).length, 1, 'общий плеер Kodik по ID Shikimori');
      await players.forRelease(release);
      assert.equal(calls, 1, 'в течение минуты — из кэша');
      up = true;
      mock.timers.tick(61_000);
      const full = await players.forRelease(release);
      assert.equal(calls, 2);
      assert.equal(full[0].dubs.length, 1);
      mock.timers.tick(10 * 60_000);
      await players.forRelease(release);
      assert.equal(calls, 2, 'полный список ещё в кэше');
    } finally {
      mock.timers.reset();
      stub.restore();
    }
  });

  test('без Kodik и Shikimori Alloha находит тайтл по названию', async () => {
    const store = new Store(':memory:');
    const named = { ...release, title: 'Атака титанов', titleEn: 'Attack on Titan', year: 2013, type: 'ТВ' } as Release;
    const stub = stubFetch({
      'https://alloha.test/': (url) => {
        if (url.searchParams.get('name')) {
          return { status: 'success', data: [{ name: 'Атака титанов', year: 2013, category: 'Сериал', category_id: 4, id_kp: 749374 }] };
        }
        assert.equal(url.searchParams.get('kp'), '749374');
        const episodes = { 1: { episode: 1, translation: { 10: { translation: 'AniLibria' } } } };
        return { status: 'success', data: { iframe: 'https://alloha.player/?x=1', translation_iframe: { 10: { name: 'AniLibria' } }, seasons: { 1: { season: 1, episodes } } } };
      },
    });
    try {
      const players = new Players({ kodikToken: null, kodikApi: 'x', allohaToken: 'A', allohaApi: 'https://alloha.test', shikimoriUrl: null, store, log: () => undefined });
      const found = await players.forRelease(named);
      assert.deepEqual(found.map((p) => p.id), ['kodik', 'alloha']);
      assert.deepEqual(found[1].dubs.map((d) => [d.title, d.lastEpisode]), [['AniLibria', 1]]);
    } finally {
      stub.restore();
      store.close();
    }
  });

  test('Kodik, CVH и Alloha: ID Кинопоиска для Alloha берётся у Kodik', async () => {
    const store = new Store(':memory:');
    const stub = stubFetch({
      'https://kodik.test/search': () => ({ results: [result(609, 'AniDUB', 'voice', 3, { kinopoisk_id: '555', last_season: 1 })] }),
      'https://cvh.test/': () => ({ isSerial: true, items: [{ voiceStudio: 'Dream Cast', season: 1, episode: 2 }] }),
      'https://alloha.test/': (url) => {
        assert.equal(url.searchParams.get('kp'), '555');
        return { data: { iframe: 'https://alloha.player/?x=1', translations: [{ id: 9, name: 'AniDUB' }], seasons: [{ season: 1, episodes: [{ episode: 1 }] }] } };
      },
    });
    try {
      const players = new Players({
        kodikToken: 'T',
        kodikApi: 'https://kodik.test',
        cvhPublisherId: 'P',
        cvhApi: 'https://cvh.test/api/v1',
        playerUrl: 'https://player.test',
        allohaToken: 'A',
        allohaApi: 'https://alloha.test/v2',
        shikimoriUrl: null,
        store,
        log: () => undefined,
      });
      assert.deepEqual(players.enabled, ['anilibria', 'kodik (озвучки по токену)', 'cvh', 'alloha']);
      const noPlayerDomain = new Players({ kodikToken: null, kodikApi: 'x', cvhPublisherId: 'P', log: () => undefined });
      assert.deepEqual(noPlayerDomain.enabled, ['anilibria', 'kodik (общий плеер)'], 'без поддомена плеера CVH выключен');
      assert.deepEqual((await players.forRelease(release)).map((p) => p.id), ['kodik', 'cvh', 'alloha']);
      assert.equal(store.releaseIds(1)?.kinopoisk, '555');
    } finally {
      stub.restore();
      store.close();
    }
  });
});
