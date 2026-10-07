import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import WebTorrent from 'webtorrent';
import { heightName, pickQuality, qualityOptions } from '../../shared/torrents.ts';
import type { Release, TorrentVariant } from '../../shared/types.ts';
import { Store, type TorrentRow } from '../db.ts';
import { episodeNumber, folderSeason, parseLayout } from './layout.ts';
import { TorrentLibrary } from './library.ts';
import { infoHashOf, publicTracker, safeMagnet } from './magnet.ts';
import { type Candidate, fromAniLibria, fromJackett, pickCandidates, type SearchReport, skipReason, TorrentSearch } from './search.ts';
import { audioArgs, ffmpegArgs, type ProbeInfo, summarizeProbe, TorrentStreamer, videoArgs } from './streamer.ts';
import { knownStudio, studiosIn } from './studios.ts';
import { explicitSeasons, heightOf, matchTorrent, releaseTarget, searchQueries, titleFacts, yearsOf } from './titles.ts';
import { studioKey, studioOf, type TorrentInfo, torrentSource } from './variants.ts';

/** Тайтл для тестов: только поля, которые нужны поиску раздач. */
function release(fields: Partial<Release> & Pick<Release, 'title'>): Release {
  return {
    id: 1,
    alias: 'test',
    titleEn: null,
    poster: null,
    type: 'ТВ',
    year: 2020,
    season: null,
    ageRating: null,
    isOngoing: false,
    episodesTotal: null,
    publishDay: null,
    freshAt: null,
    genres: [],
    titleAlt: null,
    description: null,
    notification: null,
    averageDuration: null,
    favorites: null,
    blocked: false,
    voices: [],
    externalPlayer: null,
    shikimoriId: null,
    rating: null,
    episodes: [],
    ...fields,
  };
}

describe('разбор раздачи', () => {
  test('номер серии из имени файла', () => {
    const cases: [string, number][] = [
      ['Jujutsu Kaisen - 01 [BDRip 1080p HEVC].mkv', 1],
      ['[SubsPlease] Sousou no Frieren - 12 (1080p) [ABCD1234].mkv', 12],
      ['Frieren.S01E05.1080p.WEB-DL.mkv', 5],
      ['[Beatrice-Raws] Title 05v2 [BDRip 1920x1080 HEVC FLAC].mkv', 5],
      ['Title 2 - 03.mkv', 3],
      ['86 - 01.mkv', 1],
      ['Title_05_720p.mkv', 5],
      ['Title - 05 1920x1080.mkv', 5],
      ['Title 2024 - 07.mkv', 7],
      ['Магическая битва - 08 серия.mkv', 8],
    ];
    for (const [name, expected] of cases) assert.equal(episodeNumber(name), expected, name);
  });

  test('серии и озвучки внешними файлами по папкам студий', () => {
    const files = [
      { path: 'JJK [BDRip 1080p]/JJK - 01 [BDRip 1080p].mkv', length: 1000 },
      { path: 'JJK [BDRip 1080p]/JJK - 02 [BDRip 1080p].mkv', length: 1000 },
      { path: 'JJK [BDRip 1080p]/RUS Sound/[AniLibria]/JJK - 01.mka', length: 10 },
      { path: 'JJK [BDRip 1080p]/RUS Sound/[AniLibria]/JJK - 02.mka', length: 10 },
      { path: 'JJK [BDRip 1080p]/RUS Sound/[Dream Cast]/JJK - 02.mka', length: 10 },
      { path: 'JJK [BDRip 1080p]/RUS Sound/JJK - 01 [AniDub].mka', length: 10 },
      { path: 'JJK [BDRip 1080p]/RUS Subs/[CR]/JJK - 01.ass', length: 1 },
      { path: 'JJK [BDRip 1080p]/Extras/NCOP.mkv', length: 50 },
    ];
    const layout = parseLayout('JJK', files);
    assert.deepEqual(layout.episodes, [
      { ordinal: 1, file: 0 },
      { ordinal: 2, file: 1 },
    ]);
    assert.deepEqual(
      layout.external.map((d) => [d.title, d.files]),
      [
        ['AniDub', { 1: 5 }],
        ['AniLibria', { 1: 2, 2: 3 }],
        ['Dream Cast', { 2: 4 }],
      ],
    );
  });

  test('один видеофайл — фильм, его звук без номера тоже подходит', () => {
    const layout = parseLayout('Movie', [
      { path: 'Movie (2016) [BDRip 2160p]/Movie.2016.2160p.mkv', length: 9000 },
      { path: 'Movie (2016) [BDRip 2160p]/Rus Sound/Movie.2016 [Дубляж].mka', length: 90 },
    ]);
    assert.deepEqual(layout.episodes, [{ ordinal: 1, file: 0 }]);
    assert.deepEqual(layout.external, [{ title: 'Дубляж', files: { 1: 1 } }]);
  });

  test('сборник сезонов: папка своего сезона, сквозные номера — с единицы', () => {
    const files = [
      { path: 'AoT [TV-1, TV-2]/Season 1/AoT - 01.mkv', length: 100 },
      { path: 'AoT [TV-1, TV-2]/Season 1/AoT - 02.mkv', length: 100 },
      { path: 'AoT [TV-1, TV-2]/Season 2/AoT - 26.mkv', length: 100 },
      { path: 'AoT [TV-1, TV-2]/Season 2/AoT - 27.mkv', length: 100 },
      { path: 'AoT [TV-1, TV-2]/RUS Sound/Season 2/[AniDub]/AoT - 26.mka', length: 1 },
      { path: 'AoT [TV-1, TV-2]/RUS Sound/Season 1/[AniDub]/AoT - 01.mka', length: 1 },
    ];
    const second = parseLayout('AoT', files, { season: 2 });
    assert.deepEqual(second.episodes, [
      { ordinal: 1, file: 2 },
      { ordinal: 2, file: 3 },
    ]);
    assert.deepEqual(second.external, [{ title: 'AniDub', files: { 1: 4 } }]);
    assert.deepEqual(parseLayout('AoT', files, { season: 1 }).episodes.map((e) => e.file), [0, 1]);
    assert.deepEqual(parseLayout('AoT', files, { season: 3 }).episodes, [], 'своего сезона в сборнике нет');
    assert.deepEqual([folderSeason('Season 2'), folderSeason('[ТВ-3]'), folderSeason('S04'), folderSeason('[AniDub]')], [2, 3, 4, null]);
  });

  test('сборник без папок, серии подряд: свой сезон — по числу серий тайтла', () => {
    const files = Array.from({ length: 47 }, (_, i) => ({ path: `JJK [1-47]/JJK - ${String(i + 1).padStart(2, '0')}.mkv`, length: 100 }));
    const first = parseLayout('JJK', files, { season: 1, episodes: 24 });
    assert.deepEqual([first.episodes.length, first.episodes[0], first.episodes[23]], [24, { ordinal: 1, file: 0 }, { ordinal: 24, file: 23 }]);
    const second = parseLayout('JJK', files, { season: 2, episodes: 23, lastSeason: true });
    assert.deepEqual([second.episodes.length, second.episodes[0], second.episodes[22]], [23, { ordinal: 1, file: 24 }, { ordinal: 23, file: 46 }]);
    assert.deepEqual(parseLayout('JJK', files, { season: 2, episodes: 23, lastSeason: false }).episodes, [], 'сезон из середины без папок не угадать');
    assert.deepEqual(parseLayout('JJK', files, { season: 1 }).episodes, [], 'без числа серий тоже');
  });

  test('info hash из magnet-ссылки, hex и base32; открытые трекеры в довесок', () => {
    assert.equal(infoHashOf('magnet:?xt=urn:btih:F23CA2F001AD41F15FB1417FBF67D10149B3BFEE&dn=x'), 'f23ca2f001ad41f15fb1417fbf67d10149b3bfee');
    assert.equal(infoHashOf('magnet:?xt=urn:btih:6I6KF4ABVVA7CX5RIF736Z6RAFE3HP7O'), 'f23ca2f001ad41f15fb1417fbf67d10149b3bfee');
    assert.equal(infoHashOf('f23ca2f001ad41f15fb1417fbf67d10149b3bfee'), 'f23ca2f001ad41f15fb1417fbf67d10149b3bfee');
    assert.equal(infoHashOf('https://example.com/file.torrent'), null);
    const magnet = safeMagnet('magnet:?xt=urn:btih:F23CA2F001AD41F15FB1417FBF67D10149B3BFEE&dn=JJK&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce', ['udp://open.stealth.si:80/announce', 'udp://t.example:1/a'])!;
    assert.equal(magnet.match(/open\.stealth/g)?.length, 1, 'свой трекер не дублируем');
    assert.ok(magnet.startsWith('magnet:?xt=urn:btih:f23ca2f001ad41f15fb1417fbf67d10149b3bfee&dn=JJK&tr='));
    assert.ok(magnet.endsWith(`&tr=${encodeURIComponent('udp://t.example:1/a')}`));
    assert.ok(safeMagnet('f23ca2f001ad41f15fb1417fbf67d10149b3bfee')?.startsWith('magnet:?xt=urn:btih:f23ca2f001ad41f15fb1417fbf67d10149b3bfee&tr='));
  });

  test('magnet с чужого сайта: ни веб-сидов, ни трекеров во внутренней сети', () => {
    const hostile = [
      'magnet:?xt=urn:btih:f23ca2f001ad41f15fb1417fbf67d10149b3bfee',
      'ws=http%3A%2F%2F169.254.169.254%2Flatest%2F',
      'as=http%3A%2F%2F10.0.0.1%2Fx.torrent',
      'tr=http%3A%2F%2F127.0.0.1%3A3000%2Fapi%2Fhealth',
      'tr=http%3A%2F%2Fretracker.local%2Fannounce',
      'tr=udp%3A%2F%2F%5B%3A%3A1%5D%3A80',
      'tr=http%3A%2F%2F2130706433%2F',
      'tr=http%3A%2F%2Fbt.t-ru.org%2Fann%3Fmagnet',
      'x.pe=1.2.3.4:51413',
    ].join('&');
    const magnet = safeMagnet(hostile, [])!;
    assert.equal(magnet, `magnet:?xt=urn:btih:f23ca2f001ad41f15fb1417fbf67d10149b3bfee&tr=${encodeURIComponent('http://bt.t-ru.org/ann?magnet')}&x.pe=1.2.3.4:51413`);
    assert.deepEqual(
      ['udp://tracker.opentrackr.org:1337/announce', 'http://192.168.1.1/a', 'http://172.20.0.5/a', 'http://100.70.1.1/a', 'http://[fd00::1]/a', 'file:///etc/passwd', 'http://tracker/a'].map(publicTracker),
      [true, false, false, false, false, false, false],
    );
  });
});

describe('ffmpeg для браузера', () => {
  const probe = (video: Partial<NonNullable<ProbeInfo['video']>> & { codec: string }, audio: ProbeInfo['audio'] = [{ index: 0, codec: 'aac', channels: 2, title: null, language: null }]): ProbeInfo => ({
    duration: 1440,
    video: { height: 1080, tenBit: false, ...video },
    audio,
  });

  test('H.264 8 бит и HEVC копируем, H.264 10 бит перекодируем', () => {
    assert.deepEqual(videoArgs(probe({ codec: 'h264' }).video), ['-c:v', 'copy']);
    assert.deepEqual(videoArgs(probe({ codec: 'hevc', tenBit: true, height: 2160 }).video), ['-c:v', 'copy', '-tag:v', 'hvc1']);
    assert.ok(videoArgs(probe({ codec: 'h264', tenBit: true }).video).includes('libx264'));
    assert.ok(videoArgs(probe({ codec: 'hevc', height: 2160 }).video, true).join(' ').includes('libx264 -preset veryfast'), 'HEVC для устройства без HEVC — в H.264');
    assert.ok(videoArgs(probe({ codec: 'hevc', height: 2160 }).video, true).join(' ').includes('scale=-2:min(ih\\,1080)'), 'и не больше 1080p');
    assert.deepEqual(audioArgs({ codec: 'aac', channels: 2 }), ['-c:a', 'copy']);
    assert.deepEqual(audioArgs({ codec: 'flac', channels: 2 }), ['-c:a', 'aac', '-ac', '2', '-b:a', '192k']);
    assert.deepEqual(audioArgs({ codec: 'aac', channels: 6 }), ['-c:a', 'aac', '-ac', '2', '-b:a', '192k']);
  });

  test('озвучка внутри файла — своя дорожка, внешняя — второй вход', () => {
    const video = probe({ codec: 'h264' }, [
      { index: 0, codec: 'aac', channels: 2, title: 'Japanese', language: 'jpn' },
      { index: 1, codec: 'ac3', channels: 6, title: 'AniLibria', language: 'rus' },
    ]);
    const embedded = ffmpegArgs({ video: 'http://v', audio: null }, { kind: 'embedded', index: 1 }, video, null, '/out');
    assert.ok(embedded.join(' ').includes('-map 0:v:0 -map 0:a:1?'));
    assert.ok(embedded.join(' ').includes('-c:a aac -ac 2'), 'AC3 5.1 → AAC стерео');
    const external = ffmpegArgs({ video: 'http://v', audio: 'http://a' }, { kind: 'external', file: 7 }, video, probe({ codec: 'h264' }), '/out');
    assert.ok(external.join(' ').includes('-i http://v -i http://a -map 0:v:0 -map 1:a:0'));
    assert.ok(external.join(' ').includes('-hls_playlist_type event'));
    // С середины серии: обе дорожки с одной секунды, качать начало не нужно.
    const later = ffmpegArgs({ video: 'http://v', audio: 'http://a' }, { kind: 'external', file: 7 }, video, probe({ codec: 'h264' }), '/out', 600);
    assert.ok(later.join(' ').includes('-ss 600 -i http://v -ss 600 -i http://a'));
    assert.ok(!embedded.includes('-ss'));
  });

  test('ffprobe: 10 бит, длительность и дорожки с названиями', () => {
    const info = summarizeProbe({
      format: { duration: '1420.5' },
      streams: [
        { codec_type: 'video', codec_name: 'hevc', height: 2160, pix_fmt: 'yuv420p10le' },
        { codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { title: 'AniLibria', language: 'rus' } },
        { codec_type: 'subtitle', codec_name: 'ass' },
        { codec_type: 'audio', codec_name: 'flac', channels: 2, tags: { language: 'jpn' } },
      ],
    });
    assert.deepEqual(info.video, { codec: 'hevc', height: 2160, tenBit: true });
    assert.equal(info.duration, 1420.5);
    assert.deepEqual(info.audio.map((a) => [a.index, a.title, a.language]), [
      [0, 'AniLibria', 'rus'],
      [1, null, 'jpn'],
    ]);
  });
});


describe('названия раздач', () => {
  const jjk = release({ title: 'Магическая битва', titleEn: 'Jujutsu Kaisen', year: 2020, episodesTotal: 24 });
  const jjk2 = release({ title: 'Магическая битва 2', titleEn: 'Jujutsu Kaisen 2nd Season', year: 2023, episodesTotal: 23 });
  const jjk0 = release({ title: 'Магическая битва 0', titleEn: 'Jujutsu Kaisen 0', year: 2021, type: 'Фильм', episodesTotal: 1 });
  const kaiju = release({ title: 'Кайдзю номер восемь', titleEn: 'Kaiju No. 8', year: 2024, episodesTotal: 12 });
  const aot2 = release({ title: 'Атака титанов 2', titleEn: 'Shingeki no Kyojin Season 2', year: 2017, episodesTotal: 12 });
  const fits = (target: Release, title: string) => matchTorrent(releaseTarget(target), titleFacts(title));

  test('сезоны, годы, серии и качество из названия', () => {
    const facts = titleFacts('Магическая битва (ТВ-2) / Jujutsu Kaisen 2nd Season [TV] [1-23 из 23] [RUS(int), JAP+Sub] [2023, WEBRip] [1080p]');
    assert.deepEqual(facts.seasons, [2]);
    assert.deepEqual(facts.years, [2023, 2023]);
    assert.deepEqual(facts.episodes, { from: 1, to: 23, total: 23 });
    assert.equal(facts.height, 1080);
    assert.equal(facts.tv, true);
    assert.deepEqual(explicitSeasons('Атака титанов (ТВ-1, ТВ-2, ТВ-3)'), [1, 2, 3]);
    assert.deepEqual(explicitSeasons('Магическая битва (1 сезон: 1-24 серии из 24)'), [1]);
    assert.deepEqual(explicitSeasons('Title S02E05'), [2]);
    assert.deepEqual(explicitSeasons('Title Seasons 1-3'), [1, 2, 3]);
    assert.deepEqual(explicitSeasons('Title [TV] [1-24 из 24]'), []);
    assert.deepEqual(yearsOf('Title [BDRip 1920x1080] [2020-2023]'), [2020, 2023]);
    assert.equal(heightOf('Человек-бензопила [2160p]'), 2160);
    assert.equal(heightOf('Title WEB-DL 4K HDR'), 2160);
    assert.equal(heightOf('Title [BDRip 1920x1080]'), 1080);
    assert.deepEqual(titleFacts('[AniLibria.TV] Магическая битва / Jujutsu Kaisen [01-24] [WEBRip 1080p]').episodes, { from: 1, to: 24, total: null });
    assert.deepEqual(titleFacts('Title [TV]', { seasons: [3], relased: 2019, quality: 2160 }).seasons, [3], 'Jacred сам разобрал сезон');
  });

  test('подходит свой сезон, а не соседний, фильм, другой год или другое название', () => {
    assert.ok(fits(jjk, 'Магическая битва / Jujutsu Kaisen [TV] [1-24 из 24] [RUS(ext), JAP+Sub] [2020, BDRip] [1080p]').ok);
    assert.ok(fits(jjk, 'Магическая битва (1 сезон: 1-24 серии из 24) / Jujutsu Kaisen (2020) BDRip 1080p | AniLibria, AniDub').ok);
    assert.ok(fits(jjk, 'Магическая битва (1 сезон: 1-24 серии из 24) / Jujutsu Kaisen / 2020 / ПМ (AniLibria) / WEB-DLRip (1080p)').ok, 'Kinozal');
    assert.equal(fits(jjk, 'Магическая битва (ТВ-2) / Jujutsu Kaisen 2nd Season [TV] [1-23 из 23] [2023, WEBRip] [1080p]').ok, false);
    assert.equal(fits(jjk, 'Магическая битва 0 / Jujutsu Kaisen 0 [Movie] [RUS(int)] [2021, BDRip] [1080p]').ok, false);
    assert.equal(fits(jjk, 'Магическая битва / Jujutsu Kaisen [TV] [1-24 из 24] [2005, DVDRip]').reason, 'другой год (2005)');
    assert.equal(fits(jjk, 'Магическая битва / Jujutsu Kaisen [TV] [BDRip 1080p]').ok, false, 'без года не рискуем');
    assert.equal(fits(jjk, 'Магическая битва: Начало / Jujutsu Kaisen Origins [TV] [1-24 из 24] [2020]').ok, false);
    assert.equal(fits(jjk, 'Магическая битва / Jujutsu Kaisen [TV] [1-48 из 48] [2020]').reason, 'другое число серий (48)');

    assert.ok(fits(jjk2, 'Магическая битва (ТВ-2) / Jujutsu Kaisen 2nd Season [TV] [1-23 из 23] [2023, WEBRip] [1080p]').ok);
    assert.equal(fits(jjk2, 'Магическая битва / Jujutsu Kaisen [TV] [1-24 из 24] [2020, BDRip] [1080p]').ok, false);

    assert.ok(fits(jjk0, 'Магическая битва 0 / Jujutsu Kaisen 0 [Movie] [RUS(int)] [2021, BDRip] [1080p]').ok);
    assert.equal(fits(jjk0, 'Магическая битва / Jujutsu Kaisen [TV] [1-24 из 24] [2020, BDRip] [1080p]').ok, false);

    assert.ok(fits(kaiju, 'Кайдзю номер 8 / Kaiju No. 8 [TV] [1-12 из 12] [RUS(int)] [2024, WEB-DL] [1080p]').ok, '8 — часть названия, а не сезон');
    assert.equal(fits(kaiju, 'Кайдзю номер 8 (ТВ-2) / Kaiju No. 8 Season 2 [TV] [1-11 из 11] [2025, WEB-DL] [1080p]').ok, false);

    const pack = fits(aot2, 'Атака титанов (ТВ-1, ТВ-2) / Shingeki no Kyojin [TV] [1-37 из 37] [2013-2017, BDRip] [1080p]');
    assert.deepEqual(pack, { ok: true, pack: true });
    assert.equal(releaseTarget(aot2).season, 2);
    assert.equal(releaseTarget(jjk2).season, 2);
    assert.equal(releaseTarget(jjk0).season, 0);
  });

  test('что спрашивать у поиска: название без сезона', () => {
    assert.deepEqual(searchQueries(jjk2), ['Магическая битва', 'Jujutsu Kaisen']);
    assert.deepEqual(searchQueries(release({ title: 'Ванпанчмен 3', titleEn: 'One Punch Man Season 3' })), ['Ванпанчмен', 'One Punch Man']);
    assert.deepEqual(searchQueries(release({ title: 'Моб Психо 100 III', titleEn: null })), ['Моб Психо 100']);
  });
});

describe('поиск раздач', () => {
  const hash = (n: number) => n.toString(16).padStart(40, '0');
  const jjk = release({ title: 'Магическая битва', titleEn: 'Jujutsu Kaisen', year: 2020, episodesTotal: 24 });
  const jacred = {
    Results: [
      { Tracker: 'rutracker', Title: 'Магическая битва / Jujutsu Kaisen [TV] [1-24 из 24] [RUS(ext), JAP+Sub] [2020, BDRip] [1080p]', MagnetUri: `magnet:?xt=urn:btih:${hash(1)}`, Seeders: 50, Size: 1e10, info: { voices: ['AniDub', 'AniLibria'] } },
      { Tracker: 'rutor', Title: 'Магическая битва (1 сезон: 1-24 серии из 24) / Jujutsu Kaisen (2020) WEB-DL 720p', MagnetUri: `magnet:?xt=urn:btih:${hash(2)}`, Seeders: 10 },
      { Tracker: 'rutracker', Title: 'Магическая битва (ТВ-2) / Jujutsu Kaisen 2nd Season [TV] [1-23 из 23] [2023, WEBRip] [1080p]', MagnetUri: `magnet:?xt=urn:btih:${hash(3)}`, Seeders: 99 },
      { Tracker: 'kinozal', Title: 'Магическая битва / Jujutsu Kaisen [TV] [1-24 из 24] [2020, BDRip] [2160p]', MagnetUri: `magnet:?xt=urn:btih:${hash(4)}`, Seeders: 0 },
      { Title: 'Без magnet-ссылки', Link: 'https://tracker.test/t.torrent', Seeders: 5 },
    ],
  };
  const anilibria = {
    releaseTorrents: async () => [
      { hash: hash(5), quality: { value: '1080p' }, codec: { value: 'AVC' }, seeders: 7, size: 5e9, label: 'Jujutsu Kaisen [WEBRip 1080p]' },
      { magnet: `magnet:?xt=urn:btih:${hash(6)}`, quality: { value: '720p' }, seeders: 30 },
    ],
  };

  test('ответы Jacred и AniLibria → раздачи; разбираем только подходящие тайтлу и живые', async () => {
    const requests: string[] = [];
    const fetchStub = (async (url: string) => {
      requests.push(url);
      return new Response(JSON.stringify(jacred));
    }) as unknown as typeof fetch;
    const search = new TorrentSearch({ jackett: ['https://jac.test'], apiKey: '', userAgent: 'test', anilibria, fetch: fetchStub, interval: 0 });
    assert.deepEqual(search.sources, ['AniLibria', 'jac.test']);
    const report = await search.find(jjk);
    assert.deepEqual(requests.map((u) => new URL(u).searchParams.get('Query')), ['Магическая битва'], 'по-русски нашлось достаточно — в оригинале не спрашиваем');
    assert.ok(requests.every((u) => u.startsWith('https://jac.test/api/v2.0/indexers/all/results?apikey=&Query=')));
    assert.equal(report.found, 6);
    assert.deepEqual(report.candidates.map((c) => c.infoHash), [hash(5), hash(1), hash(2)], 'AniLibria — лучшая 1080p; S2 не подходит, у 4K нет раздающих');
    assert.ok(report.candidates.every((c) => c.magnet.includes('&tr=')), 'с открытыми трекерами');
    assert.equal(report.rejected.find((r) => r.title.includes('ТВ-2'))?.reason, 'другое название или сезон');
    assert.deepEqual(report.errors, []);
  });

  test('источник не ответил — ошибка в отчёте, остальные работают', async () => {
    const down = (async () => new Response('nope', { status: 502 })) as unknown as typeof fetch;
    const report = await new TorrentSearch({ jackett: ['https://jac.test'], apiKey: 'k', userAgent: 'test', anilibria, fetch: down, interval: 0 }).find(jjk);
    assert.deepEqual(report.errors, ['jac.test: ответ 502']);
    assert.deepEqual(report.failed, ['jacred']);
    assert.deepEqual(report.candidates.map((c) => c.infoHash), [hash(5)]);
  });

  test('«слишком много запросов» (429): ждём и повторяем, а не теряем трекеры', async () => {
    let calls = 0;
    const busyOnce = (async () => (++calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : new Response(JSON.stringify(jacred)))) as unknown as typeof fetch;
    const report = await new TorrentSearch({ jackett: ['https://jac.test'], apiKey: '', userAgent: 'test', anilibria: null, fetch: busyOnce, interval: 0, retryDelay: 0 }).find(jjk);
    assert.deepEqual(report.errors, []);
    assert.equal(report.candidates.length, 2);
    const busy = (async () => new Response('', { status: 429 })) as unknown as typeof fetch;
    const failed = await new TorrentSearch({ jackett: ['https://jac.test'], apiKey: '', userAgent: 'test', anilibria: null, fetch: busy, interval: 0, retryDelay: 0 }).find(jjk);
    assert.deepEqual(failed.errors, ['jac.test: слишком много запросов (429), повторю позже']);
    assert.deepEqual(failed.failed, ['jacred']);
  });

  test('украинская раздача и raw не нужны', () => {
    assert.equal(skipReason({ title: 'Магічна битва / Jujutsu Kaisen (сезон 1) (2020) WEBDL 720р', tracker: 'toloka, mazepa' }), 'украинская раздача');
    assert.equal(skipReason({ title: 'Jujutsu Kaisen | Магическая битва [2020, TV, 24 + SP] WEBRip 720p raw', tracker: 'nnmclub' }), 'без перевода (raw)');
    assert.equal(skipReason({ title: 'Магическая битва (1 сезон: 1-24 серии из 24) / Jujutsu Kaisen / 2020-2021 / ЛМ (SHIZA Project)', tracker: 'kinozal' }), null);
  });

  test('разбор ответов и выбор раздач', () => {
    const found = fromJackett(jacred.Results[0], 'jac.test')!;
    assert.deepEqual([found.tracker, found.seeders, found.height, found.voices], ['rutracker', 50, 1080, ['AniDub', 'AniLibria']]);
    assert.equal(fromJackett({ Title: 'x', Link: 'https://t/x.torrent' }, 'jac.test'), null);
    const own = fromAniLibria({ hash: hash(7), quality: { value: '2160p' }, seeders: '3' }, jjk)!;
    assert.deepEqual([own.source, own.height, own.seeders, own.title], ['anilibria', 2160, 3, 'Магическая битва [AniLibria 2160p]']);
    const candidate = (n: number, height: number, seeders: number, voices: string[] = []): Candidate => ({
      source: 'jacred', tracker: 't', title: `t${n}`, magnet: '', infoHash: hash(n), seeders, size: null, height, voices, studios: studiosIn(voices), facts: null, season: 1, pack: false, episodes: null, lastSeason: true,
    });
    const picked = pickCandidates([candidate(1, 1080, 5), candidate(2, 1080, 50), candidate(3, 1080, 20), candidate(4, 1080, 1, ['a', 'b', 'c']), candidate(5, 2160, 9), candidate(6, 720, 0)]);
    assert.deepEqual(picked.map((c) => c.title), ['t2', 't3', 't5', 't1'], 'по 2 самых живых на качество, потом остальные; с одним раздающим и без раздающих — нет');

    // Популярные студии: сначала раздачи, где они есть, даже если раздающих меньше.
    const popular = pickCandidates(
      [
        candidate(11, 1080, 500, ['AniLibria']),
        candidate(12, 1080, 3, ['DreamCast', 'AniDub']),
        candidate(13, 720, 2, ['Студийная Банда']),
        candidate(14, 1080, 40, ['AniDub']),
        ...Array.from({ length: 12 }, (_, i) => candidate(20 + i, 1080, 100 + i)),
      ],
      6,
    );
    assert.deepEqual(popular.map((c) => c.title), ['t12', 't13', 't11', 't14', 't31', 't30'], 'Dream Cast + AniDub, Studio Band, AniLibria, потом остальные');
    const fromOwn = (n: number, title: string, seeders: number): Candidate => ({ ...candidate(n, 1080, seeders), source: 'anilibria', title });
    assert.equal(pickCandidates([fromOwn(40, 'JJK [WEBRip 1080p][HEVC]', 50), fromOwn(41, 'JJK [WEBRip 1080p]', 20)])[0].title, 'JJK [WEBRip 1080p]', 'у AniLibria — H.264, его покажет любой браузер');
    assert.deepEqual(fromJackett({ Tracker: 'rutor', Title: 'Магическая битва (2020) WEB-DL 1080p | AniLibria, AniDub, Dream Cast', MagnetUri: `magnet:?xt=urn:btih:${hash(9)}` }, 'x')?.studios, ['AniLibria', 'AniDub', 'Dream Cast']);
    assert.ok(fromJackett({ Tracker: 'rutracker', Title: 'x', MagnetUri: `magnet:?xt=urn:btih:${hash(9)}` }, 'x')?.magnet.includes(encodeURIComponent('http://bt.t-ru.org/ann?magnet')), 'у RuTracker — его трекер');
  });

  test('популярные студии под любыми подписями', () => {
    const cases: [string, string | null][] = [
      ['DreamCast', 'Dream Cast'],
      ['MVO | Dream Cast', 'Dream Cast'],
      ['[AniDUB]', 'AniDub'],
      ['Студийная Банда', 'Studio Band'],
      ['StudioBand', 'Studio Band'],
      ['AniLibria.TV', 'AniLibria'],
      ['SHIZA Project (MVO)', 'SHIZA Project'],
      ['Reanimedia', 'Reanimedia'],
      ['JAM CLUB', 'JAM CLUB'],
      ['Jam', 'JAM CLUB'],
      ['Многоголосая закадровая', null],
      ['Pajama Party', null],
    ];
    for (const [label, expected] of cases) assert.equal(knownStudio(label)?.name ?? null, expected, label);
  });
});

describe('плеер «Торрент» из нескольких раздач', () => {
  const row = (id: number, seeders: number): TorrentRow => ({
    id, releaseId: 1, magnet: 'm', infoHash: 'h'.repeat(40), status: 'ready', info: null, error: null, addedAt: '', source: 'jacred', title: null, seeders, size: null, hint: null,
  });
  const bd: TorrentInfo = {
    name: 'BD', height: 1080, videoCodec: 'h264', tenBit: false,
    embedded: [
      { index: 0, title: 'Japanese', language: 'jpn' },
      { index: 1, title: 'MVO | AniLibria.TV', language: 'rus' },
      { index: 2, title: null, language: 'rus' },
    ],
    layout: { name: 'BD', episodes: [{ ordinal: 1, file: 0 }, { ordinal: 2, file: 1 }], external: [{ title: 'AniDub', files: { 1: 5, 2: 6 } }] },
  };
  const uhd: TorrentInfo = {
    name: 'UHD', height: 2160, videoCodec: 'hevc', tenBit: true,
    embedded: [
      { index: 0, title: '[AniLibria]', language: 'rus' },
      { index: 1, title: 'Многоголосая закадровая | SHIZA Project', language: 'rus' },
      { index: 2, title: null, language: 'jpn' },
    ],
    layout: { name: 'UHD', episodes: [{ ordinal: 1, file: 0 }], external: [] },
  };
  const hi10: TorrentInfo = { name: 'Hi10', height: 1080, videoCodec: 'h264', tenBit: true, embedded: [{ index: 0, title: 'Rus', language: 'rus' }], layout: { name: 'Hi10', episodes: [{ ordinal: 1, file: 0 }], external: [] } };

  test('одна студия из разных раздач — одна озвучка с вариантами качества', () => {
    const source = torrentSource([{ row: row(1, 50), info: bd }, { row: row(2, 10), info: uhd }, { row: row(3, 5), info: hi10 }], 'more')!;
    assert.deepEqual([source.id, source.title, source.kind, source.status], ['torrent', 'Торрент', 'torrent', 'more']);
    const ids = source.dubs.map((d) => d.id);
    assert.deepEqual(ids.slice(0, 3), ['torrent:anidub', 'torrent:anilibria', 'torrent:shiza'], 'популярные студии — первыми, в своём порядке');
    assert.equal(ids[ids.length - 1], 'torrent:jpn', 'японская — в конце');
    assert.deepEqual(source.dubs.map((d) => d.title).sort(), ['AniDub', 'AniLibria', 'SHIZA Project', 'Русская озвучка', 'Русская озвучка 2', 'Японская (оригинал)']);
    const variants = (dub: string) => source.variants!.filter((v) => v.dub === dub).map((v) => [v.id, v.height, v.codec, v.tenBit, v.transcode]);
    assert.deepEqual(variants('torrent:anilibria'), [['1:e1', 1080, 'h264', false, false], ['2:e0', 2160, 'hevc', true, false]]);
    assert.deepEqual(variants('torrent:jpn'), [['1:e0', 1080, 'h264', false, false], ['2:e2', 2160, 'hevc', true, false]]);
    assert.deepEqual(source.variants!.find((v) => v.id === '3:e0') && [source.variants!.find((v) => v.id === '3:e0')!.codec, source.variants!.find((v) => v.id === '3:e0')!.transcode], ['h264', true], 'H.264 10 бит перекодируется');
    assert.equal(source.dubs.find((d) => d.id === 'torrent:anidub')?.lastEpisode, 2);
    assert.equal(source.dubs.find((d) => d.id === 'torrent:anilibria')?.quality, 2160);
    assert.deepEqual(source.episodes, [1, 2]);
    assert.equal(torrentSource([], null), null);
    assert.equal(torrentSource([], 'searching')?.status, 'searching');
  });

  test('«Дубляж» без студии — отдельная озвучка «Дубляж»', () => {
    const dub: TorrentInfo = { name: 'D', height: 1080, videoCodec: 'h264', tenBit: false, embedded: [{ index: 0, title: 'Дубляж', language: 'rus' }, { index: 1, title: 'Rus', language: 'rus' }], layout: { name: 'D', episodes: [{ ordinal: 1, file: 0 }], external: [] } };
    assert.deepEqual(torrentSource([{ row: row(5, 1), info: dub }], null)!.dubs.map((d) => [d.id, d.title]), [['torrent:dubbing', 'Дубляж'], ['torrent:t5e1', 'Русская озвучка']]);
  });

  test('студия из подписи дорожки', () => {
    assert.deepEqual([studioOf('MVO | AniLibria.TV'), studioOf('Rus | MVO'), studioOf('Русский (AniDub)'), studioOf('AC3 5.1'), studioOf(null)], ['AniLibria.TV', null, 'AniDub', null, null]);
    assert.equal(studioKey('AniLibria.TV'), studioKey('AniLibria'));
    assert.equal(studioKey('SHIZA Project'), studioKey('SHIZA'));
    assert.notEqual(studioKey('AniDub'), studioKey('AniLibria'));
  });

  test('какое качество включить', () => {
    const v = (id: string, height: number, extra: Partial<TorrentVariant> = {}): TorrentVariant => ({ id, dub: 'd', height, codec: 'h264', tenBit: false, transcode: false, episodes: [1], seeders: 1, ...extra });
    const options = qualityOptions([v('a', 1080, { seeders: 5 }), v('b', 1080, { seeders: 50 }), v('c', 2160), v('d', 720), v('e', 480, { dub: 'other' }), v('f', 1080, { seeders: 99, transcode: true })], 'd', 1);
    assert.deepEqual(options.map((o) => [o.height, o.variant.id]), [[2160, 'c'], [1080, 'b'], [720, 'd']], 'без перекодирования, больше раздающих');
    assert.equal(pickQuality(options, 'auto')?.height, 1080, '«Авто» — 1080p, а не 4K');
    assert.equal(pickQuality(options, 2160)?.height, 2160);
    assert.equal(pickQuality(options, 480)?.height, 720, 'ближайшее');
    assert.equal(pickQuality(options.filter((o) => o.height === 2160), 'auto')?.height, 2160);
    assert.equal(pickQuality([], 'auto'), null);
    assert.deepEqual([heightName(2160), heightName(720), heightName(null)], ['4K', '720p', 'SD']);
  });
});

describe('раздачи в базе', () => {
  const found = (n: number, source: 'jacred' | 'anilibria' = 'jacred') => ({ source, magnet: `magnet:?xt=urn:btih:${String(n).padStart(40, '0')}`, infoHash: String(n).padStart(40, '0'), title: `t${n}`, seeders: n, size: null, season: 1, pack: false });

  test('поиск обновляет раздачи тайтла: готовые остаются, пропавшие — удаляются, свои — никогда', () => {
    const store = new Store(':memory:');
    const manual = store.addTorrent(1, 'magnet:?xt=urn:btih:aa', 'a'.repeat(40));
    assert.equal(manual.source, 'manual');
    store.replaceFoundTorrents(1, [found(1), found(2), found(3, 'anilibria')]);
    const [one, two] = store.torrents({ releaseId: 1 }).filter((r) => r.source === 'jacred');
    store.setTorrentReady(one.id, { name: 'x' });
    store.setTorrentError(two.id, 'нет раздающих');

    store.replaceFoundTorrents(1, [found(1), found(2), found(4)], ['anilibria']);
    const rows = store.torrents({ releaseId: 1 });
    assert.deepEqual(rows.map((r) => [r.title ?? 'своя', r.status]), [
      ['своя', 'pending'],
      ['t1', 'ready'],
      ['t2', 'pending'],
      ['t3', 'pending'],
      ['t4', 'pending'],
    ], 'готовая осталась готовой, не открывшаяся — в очередь снова, AniLibria не ответила — её раздача осталась');
    assert.deepEqual(rows[1].hint, { season: 1, pack: false, episodes: null, lastSeason: true });

    store.replaceFoundTorrents(1, [found(4)], [], new Set([found(2).infoHash]));
    assert.deepEqual(store.torrents({ releaseId: 1 }).map((r) => r.title ?? 'своя'), ['своя', 't2', 't4'], 'раздачу, которую смотрят, не убираем');
    store.replaceFoundTorrents(1, [found(4)]);
    assert.deepEqual(store.torrents({ releaseId: 1 }).map((r) => r.title ?? 'своя'), ['своя', 't4']);
    assert.equal(store.torrentSearch(1), null);
    store.saveTorrentSearch(1, 1, null);
    assert.equal(store.torrentSearch(1)?.found, 1);
    store.close();
  });

  test('база от прошлой версии получает новые столбцы', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'animini-db-'));
    const file = path.join(dir, 'old.db');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE torrents (id INTEGER PRIMARY KEY AUTOINCREMENT, release_id INTEGER NOT NULL, magnet TEXT NOT NULL, info_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', info TEXT, error TEXT, added_at TEXT NOT NULL, UNIQUE (release_id, info_hash));
      INSERT INTO torrents (release_id, magnet, info_hash, added_at) VALUES (5, 'magnet:?xt=urn:btih:bb', '${'b'.repeat(40)}', '2026-01-01');`);
    old.close();
    const store = new Store(file);
    const [row] = store.torrents();
    assert.deepEqual([row.releaseId, row.source, row.title, row.seeders, row.hint], [5, 'manual', null, null, null]);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---- Полный путь на настоящих файлах: раздачи на этой же машине → поиск → ffmpeg → HLS ----

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('серия из раздачи', { skip: !hasFfmpeg && 'нет ffmpeg' }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'animini-torrent-'));
  let seeder: any;
  const seeded: { magnet: string; infoHash: string; title: string }[] = [];
  let streamer: TorrentStreamer;
  let store: Store;
  let library: TorrentLibrary;
  const title = release({ id: 77, title: 'Тест', titleEn: 'Test', year: 2020, episodesTotal: 1 });

  /** Раздача из одной серии: видео с дорожками внутри и, если нужно, озвучка отдельным файлом. */
  const makeTorrent = (name: string, height: number, tracks: { title?: string; language?: string; freq: number }[], external?: string) => {
    const dir = path.join(root, 'seed', name);
    mkdirSync(dir, { recursive: true });
    const media = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${Math.round((height * 4) / 3)}x${height}:rate=24:duration=12`];
    tracks.forEach((t) => media.push('-f', 'lavfi', '-i', `sine=frequency=${t.freq}:duration=12`));
    const maps = ['-map', '0:v', ...tracks.flatMap((_, i) => ['-map', `${i + 1}:a`])];
    const meta = tracks.flatMap((t, i) => [...(t.title ? [`-metadata:s:a:${i}`, `title=${t.title}`] : []), ...(t.language ? [`-metadata:s:a:${i}`, `language=${t.language}`] : [])]);
    execFileSync('ffmpeg', [...media, ...maps, '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '24', '-pix_fmt', 'yuv420p', '-c:a', 'aac', ...meta, path.join(dir, 'Test - 01.mkv')]);
    if (external) {
      mkdirSync(path.join(dir, 'RUS Sound', `[${external}]`), { recursive: true });
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=12', '-c:a', 'ac3', path.join(dir, 'RUS Sound', `[${external}]`, 'Test - 01.mka')]);
    }
    return dir;
  };

  before(async () => {
    const dirs = [
      { dir: makeTorrent('Test [480p]', 480, [{ title: 'AniLibria', language: 'rus', freq: 440 }], 'AniDub'), title: 'Тест / Test [TV] [1 из 1] [2020, WEBRip] [480p]' },
      { dir: makeTorrent('Test [360p]', 360, [{ title: 'MVO | AniDub', language: 'rus', freq: 550 }, { language: 'jpn', freq: 660 }]), title: 'Тест / Test [TV] [1 из 1] [2020, WEBRip] [360p]' },
    ];
    seeder = new WebTorrent({ dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false });
    for (const { dir, title: name } of dirs) {
      const torrent: any = await new Promise((resolve) => seeder.seed(dir, { announce: [] }, resolve));
      seeded.push({ magnet: torrent.magnetURI, infoHash: torrent.infoHash, title: name });
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const s of seeded) s.magnet = `${s.magnet}&x.pe=127.0.0.1:${seeder.torrentPort}`;
    streamer = new TorrentStreamer({ dir: path.join(root, 'cache'), cacheBytes: 1e9, maxSessions: 3, uploadLimit: -1, dht: false, allowLocalPeers: true, log: () => undefined });
    await streamer.start();
    store = new Store(':memory:');
    // Поиск подменяем: он «находит» раздачи, которые раздаёт эта же машина.
    const search = {
      sources: ['test'],
      find: async (): Promise<SearchReport> => ({
        candidates: seeded.map((s, i) => ({ source: 'jacred', tracker: 'test', title: s.title, magnet: s.magnet, infoHash: s.infoHash, seeders: 10 - i, size: null, height: null, voices: [], studios: [], facts: null, season: 1, pack: false, episodes: 1, lastSeason: true })),
        matchedList: [],
        found: seeded.length,
        matched: seeded.length,
        errors: [],
        failed: [],
        rejected: [],
      }),
    } as unknown as TorrentSearch;
    library = new TorrentLibrary({ store, streamer, search, log: () => undefined });
  });

  after(async () => {
    library?.stop();
    await streamer?.close();
    await new Promise<void>((resolve) => (seeder ? seeder.destroy(() => resolve()) : resolve()));
    store?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('по умолчанию к локальным адресам из раздачи не подключаемся', { timeout: 20_000 }, async () => {
    const guarded = new TorrentStreamer({ dir: path.join(root, 'guarded'), cacheBytes: 1e9, maxSessions: 1, uploadLimit: -1, dht: false, log: () => undefined });
    await guarded.start();
    try {
      await assert.rejects(
        Promise.race([guarded.metadata(seeded[0].magnet, seeded[0].infoHash), new Promise((_, reject) => setTimeout(() => reject(new Error('нет метаданных')), 3000))]),
        /нет метаданных/,
      );
    } finally {
      await guarded.close();
    }
  });

  test('сервер сам находит раздачи, сводит озвучки и готовит HLS любой из них, в том числе с середины', { timeout: 120_000 }, async () => {
    assert.deepEqual(library.players(title), [], 'страница тайтла раздачи не ищет');
    const [first] = library.players(title, { search: true });
    assert.equal(first?.status, 'searching', 'пока ищем — плеер-заглушка');
    library.start();
    let player = first;
    for (let i = 0; i < 300 && (player?.status || !player?.dubs.length); i++) {
      await new Promise((r) => setTimeout(r, 200));
      [player] = library.players(title);
    }
    assert.equal(player?.status, null, JSON.stringify(store.torrents().map((r) => [r.status, r.error])));
    assert.deepEqual(player.dubs.map((d) => d.title), ['AniDub', 'AniLibria', 'Японская (оригинал)']);
    const anidub = player.variants!.filter((v) => v.dub === 'torrent:anidub');
    assert.deepEqual(anidub.map((v) => v.height).sort(), [360, 480], 'AniDub есть в двух качествах');

    for (const variant of player.variants!) {
      let state = library.play(variant.id, 1);
      for (let i = 0; i < 150 && state.status === 'starting'; i++) {
        await new Promise((r) => setTimeout(r, 200));
        state = library.play(variant.id, 1);
      }
      assert.equal(state.status, 'ready', `${variant.id}: ${JSON.stringify(state)}`);
      if (state.status !== 'ready') continue;
      assert.equal(state.height, variant.height);
      assert.equal(state.offset, 0);
      const playlist = await library.playlist(state.session);
      assert.ok(playlist?.includes('#EXT-X-START:TIME-OFFSET=0'));
      assert.ok(playlist?.includes('#EXTINF'));
      assert.ok(library.file(state.session, 'init.mp4'));
      assert.equal(library.file(state.session, '../../etc/passwd'), null, 'за пределы папки сессии не выйти');
    }

    // Смена озвучки на середине серии: сервер готовит с 6-й секунды, бросив прошлую подготовку.
    const [from, to] = anidub;
    let previous = library.play(from.id, 1);
    assert.equal(previous.status, 'ready');
    let later = library.play(to.id, 1, 6, previous.status === 'ready' ? previous.session : null);
    for (let i = 0; i < 150 && later.status === 'starting'; i++) {
      await new Promise((r) => setTimeout(r, 200));
      later = library.play(to.id, 1, 6);
    }
    assert.equal(later.status, 'ready', JSON.stringify(later));
    if (later.status === 'ready') {
      assert.equal(later.offset, 6);
      const playlist = (await library.playlist(later.session)) ?? '';
      const total = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
      assert.ok(total > 0 && total <= 12 - 6 + 2, `с середины — только остаток серии (${total} с)`);
    }
    // Устройство без HEVC: то же видео сервер перекодирует в H.264 — это другая подготовка.
    let converted = library.play(from.id, 1, 0, null, true);
    for (let i = 0; i < 150 && converted.status === 'starting'; i++) {
      await new Promise((r) => setTimeout(r, 200));
      converted = library.play(from.id, 1, 0, null, true);
    }
    assert.equal(converted.status, 'ready', JSON.stringify(converted));
    if (converted.status === 'ready' && previous.status === 'ready') {
      assert.notEqual(converted.session, previous.session);
      assert.equal(converted.codec, 'h264');
    }
    previous = library.play('999:e0', 1);
    assert.equal(previous.status, 'error');
    assert.equal(library.play(from.id, 2).status, 'error', 'второй серии в раздаче нет');
  });
});
