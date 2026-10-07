// Magnet-ссылки: info hash из ссылки и запасные трекеры, чтобы раздающие находились быстрее.

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Открытые трекеры. Раздачу находят и без них (DHT), но с ними — за секунды,
 * особенно если в magnet-ссылке трекеров нет или они недоступны.
 */
export const OPEN_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
];

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

/** Адрес трекера, к которому можно обращаться: публичный хост, не локальная сеть и не сам сервер. */
export function publicTracker(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/^(udp|https?|wss?):$/.test(parsed.protocol)) return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || /\.(local|localhost|internal|lan|home|arpa)$/.test(host) || !host.includes('.') && !host.includes(':')) return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168));
  }
  if (host.includes(':')) return !/^(::1?$|fe[89ab]|f[cd]|::ffff:)/.test(host);
  return true;
}

/**
 * Magnet-ссылка, которую можно отдать торрент-клиенту: info hash, название, публичные трекеры
 * (свои плюс открытые) и адреса раздающих. Веб-сиды и прочие параметры выбрасываем: ссылки
 * приходят с чужих сайтов, а по ним клиент сам пошёл бы куда угодно, в том числе внутрь сети сервера.
 */
export function safeMagnet(magnetOrHash: string, trackers: string[] = OPEN_TRACKERS): string | null {
  const infoHash = infoHashOf(magnetOrHash);
  if (!infoHash) return null;
  const params = /^magnet:\?/i.test(magnetOrHash) ? new URLSearchParams(magnetOrHash.slice(magnetOrHash.indexOf('?') + 1)) : new URLSearchParams();
  const name = params.get('dn');
  const own = params.getAll('tr').filter(publicTracker);
  const peers = params.getAll('x.pe').filter((peer) => /^[\w.:[\]-]{3,80}$/.test(peer));
  const parts = [`xt=urn:btih:${infoHash}`];
  if (name) parts.push(`dn=${encodeURIComponent(name.slice(0, 200))}`);
  for (const tracker of new Set([...own, ...trackers])) parts.push(`tr=${encodeURIComponent(tracker)}`);
  for (const peer of peers) parts.push(`x.pe=${peer}`);
  return `magnet:?${parts.join('&')}`;
}
