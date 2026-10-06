import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { frameSrc, normalizeLink } from '../../shared/players.ts';
import { kodikPlayer, playerLinkKey, toDubs, type KodikResult } from './kodik.ts';

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
    const params = { season: 'season', episode: 'episode' };
    const own = frameSrc('https://kodik.info/serial/1/h/720p?translations=false', { params, season: '4', episode: 3 });
    assert.equal(own, 'https://kodik.info/serial/1/h/720p?season=4&episode=3', 'общий плеер: меню озвучек возвращаем');
    const ours = frameSrc('https://kodik.info/serial/1/h/720p', { params, season: '1', episode: 2, hideDubs: true });
    assert.equal(ours, 'https://kodik.info/serial/1/h/720p?translations=false&season=1&episode=2');
    const noSeason = frameSrc('https://kodik.info/serial/1/h/720p', { params: { season: null, episode: 'episode' }, season: null, episode: 5 });
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
    assert.deepEqual(shared?.episodeParams, { season: null, episode: 'episode' });
    assert.equal(kodikPlayer([], null), null);
    const withDubs = kodikPlayer(toDubs([result(609, 'AniDUB', 'voice', 9)]), null);
    assert.equal(withDubs?.lastEpisode, 9);
    assert.equal(withDubs?.link, null);
  });
});
