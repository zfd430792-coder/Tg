// Команды для владельца сервера (их вызывает `sudo animini torrent …` внутри контейнера):
//   torrent add <id или алиас тайтла> <magnet-ссылка или info hash>
//   torrent list [тайтл]
//   torrent rm <номер раздачи>
// Раздачу сервер разбирает сам в течение минуты: серии, озвучки, качество.

import { pathToFileURL } from 'node:url';
import { AniLiberty } from './anilibria.ts';
import { config } from './config.ts';
import { Store, type TorrentRow } from './db.ts';
import { HostRegistry } from './media.ts';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Info hash (40 hex) из magnet-ссылки или из самого хэша; base32 тоже понимаем. */
export function infoHashOf(value: string): string | null {
  const raw = /^magnet:\?/i.test(value) ? /xt=urn:btih:([a-z0-9]+)/i.exec(value)?.[1] : value.trim();
  if (!raw) return null;
  if (/^[0-9a-f]{40}$/i.test(raw)) return raw.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(raw)) {
    let bits = '';
    for (const char of raw.toUpperCase()) bits += BASE32.indexOf(char).toString(2).padStart(5, '0');
    return bits.match(/.{4}/g)!.map((b) => Number.parseInt(b, 2).toString(16)).join('');
  }
  return null;
}

function describe(row: TorrentRow): string {
  const info = row.info as { name?: string; layout?: { episodes: unknown[]; external: unknown[] }; embedded?: unknown[]; height?: number | null } | null;
  if (row.status === 'pending') return 'разбирается…';
  if (row.status === 'error') return `ошибка: ${row.error}`;
  const episodes = info?.layout?.episodes.length ?? 0;
  const dubs = (info?.embedded?.length ?? 0) + (info?.layout?.external.length ?? 0);
  return `«${info?.name ?? ''}»: серий ${episodes}, дорожек ${dubs}${info?.height ? `, ${info.height}p` : ''}`;
}

async function main(args: string[]): Promise<number> {
  const [area, command, ...rest] = args;
  if (area !== 'torrent' || !command) {
    console.log('Команды: torrent add <тайтл> <magnet> · torrent list [тайтл] · torrent rm <номер>');
    return 1;
  }
  const store = new Store(config.dbPath);
  const api = new AniLiberty({ apiBase: config.apiBase, mediaBase: config.mediaBase, hlsProxy: false, hosts: new HostRegistry(), userAgent: config.appName });
  const releaseOf = async (idOrAlias: string) => {
    const release = await api.getRelease(idOrAlias);
    store.saveCard(release);
    return release;
  };
  try {
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
      if (!config.torrents) console.log('Торрент-плеер сейчас выключен: включите его в sudo animini config (вопрос про торрент-плеер).');
      return 0;
    }
    if (command === 'list') {
      const releaseId = rest[0] ? (await releaseOf(rest[0])).id : undefined;
      const rows = store.torrents({ releaseId });
      if (rows.length === 0) console.log('Раздач пока нет. Добавить: animini torrent add <тайтл> <magnet>');
      for (const row of rows) {
        const card = store.getCard(row.releaseId);
        console.log(`№${row.id}  ${card?.title ?? `тайтл ${row.releaseId}`} — ${describe(row)}`);
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
