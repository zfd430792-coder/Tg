import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { startParamToPath, watchStartParam } from '../shared/links.ts';
import type { Episode, Release } from '../shared/types.ts';
import { signInitData, validateInitData } from './auth.ts';
import { TtlCache } from './cache.ts';
import { Store } from './db.ts';
import { HostRegistry, absoluteUrl, buildMaster, rewritePlaylist } from './media.ts';
import { Notifier } from './notifier.ts';

const TOKEN = '123456:TEST';
const user = JSON.stringify({ id: 42, first_name: 'Аня' });

describe('initData из Telegram', () => {
  test('принимает правильно подписанные данные', () => {
    const raw = signInitData({ user, auth_date: String(Math.floor(Date.now() / 1000)), start_param: 'r_1' }, TOKEN);
    const data = validateInitData(raw, TOKEN, 3600);
    assert.equal(data?.user.id, 42);
    assert.equal(data?.startParam, 'r_1');
  });

  test('отклоняет подделку, чужой токен и протухшие данные', () => {
    const now = String(Math.floor(Date.now() / 1000));
    const raw = signInitData({ user, auth_date: now }, TOKEN);
    assert.equal(validateInitData(raw.replace('42', '43'), TOKEN, 3600), null);
    assert.equal(validateInitData(raw, '999:OTHER', 3600), null);
    const old = signInitData({ user, auth_date: String(Math.floor(Date.now() / 1000) - 7200) }, TOKEN);
    assert.equal(validateInitData(old, TOKEN, 3600), null);
    assert.equal(validateInitData('', TOKEN, 3600), null);
    assert.equal(validateInitData('user=1&hash=zz', TOKEN, 3600), null);
  });
});

describe('ссылки на видео', () => {
  test('делает абсолютные адреса', () => {
    assert.equal(absoluteUrl('/storage/a.jpg', 'https://x.top'), 'https://x.top/storage/a.jpg');
    assert.equal(absoluteUrl('//cdn.x/a.m3u8', 'https://x.top'), 'https://cdn.x/a.m3u8');
    assert.equal(absoluteUrl('https://cdn.x/a.m3u8', 'https://x.top'), 'https://cdn.x/a.m3u8');
    assert.equal(absoluteUrl('javascript:alert(1)', 'https://x.top'), null);
    assert.equal(absoluteUrl(null, 'https://x.top'), null);
  });

  test('прокси пускает только на известные хосты', () => {
    const hosts = new HostRegistry();
    hosts.remember('https://cache.example/videos/1/index.m3u8');
    assert.ok(hosts.allows('https://cache.example/other.ts'));
    assert.ok(!hosts.allows('https://evil.example/x'));
    assert.ok(!hosts.allows('file:///etc/passwd'));
    assert.ok(!hosts.allows('not a url'));
  });

  test('переписывает сегменты и URI в плейлисте', () => {
    const body = ['#EXTM3U', '#EXT-X-MAP:URI="init.mp4"', '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/k"', '#EXTINF:4,', 'seg0.m4s', '#EXTINF:4,', 'https://other.example/seg1.ts'].join('\n');
    const out = rewritePlaylist(body, 'https://cdn.example/v/720/index.m3u8', (u) => `P(${u})`);
    assert.match(out, /URI="P\(https:\/\/cdn\.example\/v\/720\/init\.mp4\)"/);
    assert.match(out, /URI="P\(https:\/\/keys\.example\/k\)"/);
    assert.match(out, /^P\(https:\/\/cdn\.example\/v\/720\/seg0\.m4s\)$/m);
    assert.match(out, /^P\(https:\/\/other\.example\/seg1\.ts\)$/m);
    assert.match(out, /^#EXTINF:4,$/m);
  });

  test('мастер-плейлист перечисляет качества по возрастанию', () => {
    const master = buildMaster([
      { quality: 1080, url: 'https://c/1080.m3u8' },
      { quality: 480, url: 'https://c/480.m3u8' },
    ]);
    const lines = master.trim().split('\n');
    assert.equal(lines[0], '#EXTM3U');
    assert.match(lines[2], /RESOLUTION=854x480/);
    assert.equal(lines[3], 'https://c/480.m3u8');
    assert.equal(lines[5], 'https://c/1080.m3u8');
  });
});

describe('ссылки из Telegram', () => {
  test('кодирует номер серии с точкой', () => {
    assert.equal(watchStartParam(7, 12.5), 'w_7_12p5');
    assert.equal(startParamToPath('w_7_12p5'), '/watch/7/12.5');
    assert.equal(startParamToPath('r_9000'), '/release/9000');
    assert.equal(startParamToPath('../../etc'), null);
  });
});

describe('кэш', () => {
  test('склеивает одинаковые запросы и отдаёт старое при ошибке', async () => {
    const cache = new TtlCache();
    let calls = 0;
    const load = async () => ++calls;
    const [a, b] = await Promise.all([cache.get('k', 1000, load), cache.get('k', 1000, load)]);
    assert.equal(a, 1);
    assert.equal(b, 1);
    assert.equal(calls, 1);
    assert.equal(await cache.get('s', 0, load), 2);
    assert.equal(await cache.get('s', 0, () => Promise.reject(new Error('down'))), 2, 'источник упал — отдаём прошлый ответ');
    await assert.rejects(cache.get('n', 0, () => Promise.reject(new Error('down'))));
  });
});

function episode(ordinal: number): Episode {
  return { id: `e${ordinal}`, ordinal, name: null, preview: null, duration: 1400, opening: null, ending: null, sources: [], master: null };
}

function release(id: number, episodes: number, freshAt: string): Release {
  return {
    id,
    alias: `r${id}`,
    title: `Тайтл ${id}`,
    titleEn: null,
    poster: null,
    type: 'ТВ',
    year: 2026,
    season: null,
    ageRating: null,
    isOngoing: true,
    episodesTotal: 12,
    publishDay: null,
    freshAt,
    genres: [],
    titleAlt: null,
    description: null,
    notification: null,
    averageDuration: 24,
    favorites: 0,
    blocked: false,
    voices: [],
    episodes: Array.from({ length: episodes }, (_, i) => episode(i + 1)),
  };
}

describe('уведомления о новых сериях', () => {
  test('шлёт подписчикам только новые серии и только один раз', async () => {
    const store = new Store(':memory:');
    store.upsertUser({ id: 1, first_name: 'A' });
    store.upsertUser({ id: 2, first_name: 'B' });
    store.upsertUser({ id: 3, first_name: 'C' });
    store.setNotify(3, false);

    let current = release(10, 5, 't1');
    const sent: [number, number[]][] = [];
    const notifier = new Notifier({
      store,
      latest: async () => [current, release(11, 3, 'x')],
      release: async () => current,
      send: async (userId, _r, episodes) => {
        sent.push([userId, episodes.map((e) => e.ordinal)]);
        return userId === 2 ? 'blocked' : 'ok';
      },
    });

    store.saveCard(current);
    notifier.seed(current);
    for (const id of [1, 2, 3]) store.setSubscribed(id, 10, true);

    assert.equal(await notifier.tick(), 0, 'без новых серий ничего не шлём');

    current = release(10, 7, 't2');
    assert.equal(await notifier.tick(), 1);
    assert.deepEqual(sent, [
      [1, [6, 7]],
      [2, [6, 7]],
    ]);
    assert.deepEqual(store.subscribers(10), [1], 'заблокировавший бота и отключивший уведомления не получают');

    sent.length = 0;
    assert.equal(await notifier.tick(), 0, 'повторно не шлём');
    assert.equal(sent.length, 0);
    store.close();
  });
});

describe('прогресс просмотра', () => {
  test('история показывает последнюю серию каждого тайтла', () => {
    const store = new Store(':memory:');
    store.upsertUser({ id: 1, first_name: 'A' });
    store.saveCard(release(10, 3, 't'));
    store.saveCard(release(11, 3, 't'));
    store.saveProgress(1, { releaseId: 10, episodeId: 'a1', ordinal: 1, time: 1350, duration: 1400 });
    store.saveProgress(1, { releaseId: 11, episodeId: 'b1', ordinal: 1, time: 100, duration: 1400 });
    store.saveProgress(1, { releaseId: 10, episodeId: 'a2', ordinal: 2, time: 300, duration: 1400 });
    const history = store.history(1);
    assert.deepEqual(
      history.map((h) => [h.release.id, h.ordinal]),
      [
        [10, 2],
        [11, 1],
      ],
    );
    const progress = store.progress(1, 10);
    assert.equal(progress[0].watched, true, '96% — серия досмотрена');
    assert.equal(progress[1].watched, false);
    store.saveProgress(1, { releaseId: 10, episodeId: 'a1', ordinal: 1, time: 10, duration: 1400 });
    assert.equal(store.progress(1, 10)[0].watched, true, 'пересмотр начала не снимает отметку');
    store.close();
  });
});
