import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import WebTorrent from 'webtorrent';
import { infoHashOf } from '../cli.ts';
import { Store } from '../db.ts';
import { episodeNumber, parseLayout } from './layout.ts';
import { qualityName, type TorrentInfo, TorrentLibrary, torrentPlayer, trackTitle } from './library.ts';
import { audioArgs, ffmpegArgs, type ProbeInfo, summarizeProbe, TorrentStreamer, videoArgs } from './streamer.ts';

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

  test('info hash из magnet-ссылки, hex и base32', () => {
    assert.equal(infoHashOf('magnet:?xt=urn:btih:F23CA2F001AD41F15FB1417FBF67D10149B3BFEE&dn=x'), 'f23ca2f001ad41f15fb1417fbf67d10149b3bfee');
    assert.equal(infoHashOf('magnet:?xt=urn:btih:6I6KF4ABVVA7CX5RIF736Z6RAFE3HP7O'), 'f23ca2f001ad41f15fb1417fbf67d10149b3bfee');
    assert.equal(infoHashOf('f23ca2f001ad41f15fb1417fbf67d10149b3bfee'), 'f23ca2f001ad41f15fb1417fbf67d10149b3bfee');
    assert.equal(infoHashOf('https://example.com/file.torrent'), null);
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

describe('плеер раздачи', () => {
  const info: TorrentInfo = {
    name: 'JJK',
    height: 2160,
    videoCodec: 'hevc',
    embedded: [
      { index: 0, title: null, language: 'jpn' },
      { index: 1, title: 'AniLibria', language: 'rus' },
    ],
    layout: { name: 'JJK', episodes: [{ ordinal: 1, file: 0 }, { ordinal: 2, file: 1 }], external: [{ title: 'Dream Cast', files: { 1: 5 } }] },
  };

  test('озвучки: русские дорожки, потом внешние, японская в конце; качество в названии', () => {
    const row = { id: 3, releaseId: 1, magnet: 'm', infoHash: 'h', status: 'ready' as const, info, error: null, addedAt: '' };
    const player = torrentPlayer(row, info);
    assert.equal(player.title, 'Торрент 4K');
    assert.equal(player.kind, 'torrent');
    assert.deepEqual(player.episodes, [1, 2]);
    assert.deepEqual(player.dubs.map((d) => [d.id, d.title, d.lastEpisode, d.quality]), [
      ['torrent-3:e1', 'AniLibria', 2, 2160],
      ['torrent-3:x0', 'Dream Cast', 1, 2160],
      ['torrent-3:e0', 'Японская (оригинал)', 2, 2160],
    ]);
    assert.equal(trackTitle({ index: 4, title: null, language: null }), 'Дорожка 5');
    assert.deepEqual([qualityName(1080), qualityName(720), qualityName(null)], ['1080p', '720p', null]);
  });

  test('раздачи в базе: добавление, повтор, ошибка и удаление', () => {
    const store = new Store(':memory:');
    const row = store.addTorrent(1, 'magnet:?xt=urn:btih:aa', 'a'.repeat(40));
    assert.equal(row.status, 'pending');
    assert.equal(store.addTorrent(1, 'magnet:?xt=urn:btih:aa&tr=x', 'a'.repeat(40)).id, row.id, 'та же раздача у того же тайтла — та же запись');
    store.setTorrentError(row.id, 'нет раздающих');
    assert.equal(store.torrent(row.id)?.error, 'нет раздающих');
    store.setTorrentReady(row.id, info);
    assert.deepEqual(store.torrents({ releaseId: 1, status: 'ready' }).map((r) => r.id), [row.id]);
    assert.equal(store.removeTorrent(row.id), true);
    assert.equal(store.torrents().length, 0);
    store.close();
  });
});

// ---- Полный путь на настоящих файлах: раздача на этой же машине → ffmpeg → HLS ----

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
  const seedDir = path.join(root, 'seed', 'Test [480p]');
  let seeder: any;
  let magnet = '';
  let infoHash = '';
  let streamer: TorrentStreamer;
  let store: Store;
  let library: TorrentLibrary;

  before(async () => {
    mkdirSync(path.join(seedDir, 'RUS Sound', '[AniDub]'), { recursive: true });
    const media = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=24:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6'];
    execFileSync('ffmpeg', [...media, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '24', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-metadata:s:a:0', 'title=AniLibria', path.join(seedDir, 'Test - 01.mkv')]);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=6', '-c:a', 'ac3', path.join(seedDir, 'RUS Sound', '[AniDub]', 'Test - 01.mka')]);
    seeder = new WebTorrent({ dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false });
    const torrent: any = await new Promise((resolve) => seeder.seed(seedDir, { announce: [] }, resolve));
    await new Promise((resolve) => setTimeout(resolve, 200));
    infoHash = torrent.infoHash;
    magnet = `${torrent.magnetURI}&x.pe=127.0.0.1:${seeder.torrentPort}`;
    streamer = new TorrentStreamer({ dir: path.join(root, 'cache'), cacheBytes: 1e9, maxSessions: 2, uploadLimit: -1, dht: false, allowLocalPeers: true, log: () => undefined });
    await streamer.start();
    store = new Store(':memory:');
    library = new TorrentLibrary({ store, streamer, log: () => undefined });
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
        Promise.race([guarded.metadata(magnet, infoHash), new Promise((_, reject) => setTimeout(() => reject(new Error('нет метаданных')), 3000))]),
        /нет метаданных/,
      );
    } finally {
      await guarded.close();
    }
  });

  test('сервер разбирает раздачу и готовит HLS с встроенной и внешней озвучкой', { timeout: 60_000 }, async () => {
    const row = store.addTorrent(1, magnet, infoHash);
    library.start();
    for (let i = 0; i < 100 && store.torrent(row.id)?.status === 'pending'; i++) await new Promise((r) => setTimeout(r, 200));
    const [player] = library.players(1);
    assert.equal(player?.title, 'Торрент 480p');
    assert.deepEqual(player.dubs.map((d) => d.title), ['AniLibria', 'AniDub']);

    for (const dub of player.dubs) {
      let state = library.play(player.id, dub.id, 1);
      for (let i = 0; i < 100 && state.status === 'starting'; i++) {
        await new Promise((r) => setTimeout(r, 200));
        state = library.play(player.id, dub.id, 1);
      }
      assert.equal(state.status, 'ready', `${dub.title}: ${JSON.stringify(state)}`);
      if (state.status !== 'ready') continue;
      assert.equal(state.height, 480);
      const playlist = await library.playlist(state.session);
      assert.ok(playlist?.includes('#EXT-X-START:TIME-OFFSET=0'));
      assert.ok(playlist?.includes('#EXTINF'));
      assert.ok(library.file(state.session, 'init.mp4'));
      assert.equal(library.file(state.session, '../../etc/passwd'), null, 'за пределы папки сессии не выйти');
    }
    assert.equal(library.play(player.id, null, 2).status, 'error', 'второй серии в раздаче нет');
  });
});
