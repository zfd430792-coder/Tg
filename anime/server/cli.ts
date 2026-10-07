// Команды для владельца сервера (их вызывает `sudo animini torrent …` внутри контейнера).
// Раздачи сервер находит сам, эти команды — чтобы посмотреть, что нашлось, и помочь руками:
//   torrent status                       — работает ли поиск раздач и ffmpeg
//   torrent search <тайтл>               — найти раздачи сейчас и показать, что подошло
//   torrent list [тайтл]                 — раздачи в базе
//   torrent add <тайтл> <magnet>         — добавить свою раздачу
//   torrent rm <номер>                   — удалить раздачу

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { Release } from '../shared/types.ts';
import { AniLiberty } from './anilibria.ts';
import { config } from './config.ts';
import { Store, type TorrentRow } from './db.ts';
import { HostRegistry } from './media.ts';
import { infoHashOf } from './torrents/magnet.ts';
import { TorrentSearch } from './torrents/search.ts';
import type { TorrentInfo } from './torrents/variants.ts';

function describe(row: TorrentRow): string {
  const info = row.info as TorrentInfo | null;
  if (row.status === 'pending') return 'разбирается…';
  if (row.status === 'error') return `не открылась: ${row.error}`;
  const episodes = info?.layout?.episodes.length ?? 0;
  const dubs = (info?.embedded?.length ?? 0) + (info?.layout?.external.length ?? 0);
  return `серий ${episodes}, дорожек ${dubs}${info?.height ? `, ${info.height}p ${info.videoCodec ?? ''}` : ''}`;
}

const SOURCE: Record<TorrentRow['source'], string> = { manual: 'добавлена руками', anilibria: 'AniLibria', jacred: 'трекеры' };

async function main(args: string[]): Promise<number> {
  const [area, command, ...rest] = args;
  if (area !== 'torrent' || !command) {
    console.log('Команды: torrent status · torrent search <тайтл> · torrent list [тайтл] · torrent add <тайтл> <magnet> · torrent rm <номер>');
    return 1;
  }
  const store = new Store(config.dbPath);
  const api = new AniLiberty({ apiBase: config.apiBase, mediaBase: config.mediaBase, hlsProxy: false, hosts: new HostRegistry(), userAgent: config.appName });
  const search = new TorrentSearch({ jackett: config.torrentSearch, apiKey: config.torrentSearchKey, userAgent: `${config.appName}/0.1`, anilibria: api });
  const releaseOf = async (idOrAlias: string): Promise<Release> => {
    const release = await api.getRelease(idOrAlias);
    store.saveCard(release);
    return release;
  };
  try {
    if (command === 'status') {
      if (!config.torrents) console.log('✗ Торрент-плеер выключен (TORRENT_PLAYER=0 в .env)');
      try {
        execFileSync(config.ffmpeg, ['-version'], { stdio: 'ignore' });
        console.log('✓ ffmpeg есть');
      } catch {
        console.log(`✗ Нет ffmpeg (${config.ffmpeg}) — серии не подготовить`);
      }
      const [latest] = await api.latest(1).catch(() => []);
      const probe = latest ? await releaseOf(String(latest.id)).catch(() => null) : null;
      if (probe) {
        const started = Date.now();
        const report = await search.find(probe);
        const took = ((Date.now() - started) / 1000).toFixed(1);
        console.log(`${report.found > 0 ? '✓' : '·'} Поиск раздач (${search.sources.join(', ') || 'нет источников'}): «${probe.title}» — найдено ${report.found}, подошло ${report.matched}, за ${took} с`);
        for (const error of report.errors) console.log(`  ✗ ${error}`);
      } else {
        console.log('✗ AniLiberty не ответил — не на чем проверить поиск раздач');
      }
      const rows = store.torrents();
      const count = (status: TorrentRow['status']) => rows.filter((r) => r.status === status).length;
      console.log(`· Раздач в базе: ${rows.length} (готовы ${count('ready')}, разбираются ${count('pending')}, не открылись ${count('error')})`);
      return 0;
    }
    if (command === 'search') {
      if (!rest[0]) {
        console.log('Использование: torrent search <id или алиас тайтла, например jujutsu-kaisen>');
        return 1;
      }
      const release = await releaseOf(rest[0]);
      console.log(`Ищу раздачи для «${release.title}»${release.titleEn ? ` / ${release.titleEn}` : ''} (${release.year ?? 'год ?'}, ${release.type ?? 'тип ?'})…`);
      const report = await search.find(release);
      for (const error of report.errors) console.log(`✗ ${error}`);
      console.log(`Найдено раздач: ${report.found}, подошло тайтлу: ${report.matched}, разберу: ${report.candidates.length}`);
      for (const c of report.candidates) console.log(`  + [${c.tracker}] ${c.title} · раздающих ${c.seeders}${c.pack ? ' · сборник сезонов' : ''}`);
      const rejected = report.rejected.slice(0, 15);
      if (rejected.length) console.log('Не подошли (первые 15):');
      for (const r of rejected) console.log(`  − ${r.title} — ${r.reason}`);
      if (report.candidates.length > 0 || report.failed.length === 0) {
        store.replaceFoundTorrents(
          release.id,
          report.candidates.map((c) => ({ source: c.source, magnet: c.magnet, infoHash: c.infoHash, title: c.title, seeders: c.seeders, size: c.size, season: c.season, pack: c.pack })),
          report.failed,
        );
      }
      store.saveTorrentSearch(release.id, report.candidates.length, report.errors.join('; ') || null);
      if (report.candidates.length) console.log('Сервер разберёт их за пару минут: animini torrent list ' + (release.alias || release.id));
      return 0;
    }
    if (command === 'add') {
      const [title, link] = rest;
      const infoHash = link ? infoHashOf(link) : null;
      if (!title || !link || !infoHash) {
        console.log('Использование: torrent add <id или алиас тайтла, например jujutsu-kaisen> <magnet-ссылка>');
        return 1;
      }
      const release = await releaseOf(title);
      const magnet = /^magnet:\?/i.test(link) ? link : `magnet:?xt=urn:btih:${infoHash}`;
      const row = store.addTorrent(release.id, magnet, infoHash);
      console.log(`Раздача №${row.id} добавлена к «${release.title}». Сервер разберёт её в течение минуты — проверьте: animini torrent list`);
      if (!config.torrents) console.log('Торрент-плеер сейчас выключен: уберите TORRENT_PLAYER=0 из .env.');
      return 0;
    }
    if (command === 'list') {
      const releaseId = rest[0] ? (await releaseOf(rest[0])).id : undefined;
      const rows = store.torrents({ releaseId });
      if (rows.length === 0) console.log('Раздач пока нет: сервер ищет их, когда тайтл открывают. Найти сейчас: animini torrent search <тайтл>');
      for (const row of rows) {
        const card = store.getCard(row.releaseId);
        console.log(`№${row.id}  ${card?.title ?? `тайтл ${row.releaseId}`} — ${row.title ?? (row.info as TorrentInfo | null)?.name ?? row.infoHash} (${SOURCE[row.source]}${row.seeders !== null ? `, раздающих ${row.seeders}` : ''}): ${describe(row)}`);
      }
      return 0;
    }
    if (command === 'rm') {
      const id = Number(rest[0]);
      if (!Number.isInteger(id) || !store.removeTorrent(id)) {
        console.log('Нет такой раздачи. Номера: animini torrent list');
        return 1;
      }
      console.log(`Раздача №${id} удалена`);
      return 0;
    }
    console.log(`Неизвестная команда: ${command}`);
    return 1;
  } finally {
    store.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main(process.argv.slice(2));
