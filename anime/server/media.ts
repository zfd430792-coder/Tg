// Ссылки на картинки и видео: AniLiberty отдаёт часть путей относительными,
// а прокси видео должен пускать только на хосты, которые пришли из API.

export function absoluteUrl(value: unknown, base: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const url = value.trim();
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `${base}${url}`;
  if (/^https?:\/\//i.test(url)) return url;
  return null;
}

export class HostRegistry {
  private hosts = new Set<string>();

  constructor(initial: string[] = []) {
    for (const host of initial) this.hosts.add(host.toLowerCase());
  }

  remember(url: string): void {
    try {
      this.hosts.add(new URL(url).hostname.toLowerCase());
    } catch {
      // некорректную ссылку просто не запоминаем
    }
  }

  allows(url: string): boolean {
    try {
      const parsed = new URL(url);
      return /^https?:$/.test(parsed.protocol) && this.hosts.has(parsed.hostname.toLowerCase());
    } catch {
      return false;
    }
  }
}

export function proxiedUrl(url: string): string {
  return `/api/hls?u=${encodeURIComponent(url)}`;
}

/**
 * Переписывает ссылки внутри m3u8 так, чтобы они шли через прокси:
 * и строки-сегменты, и атрибуты URI="..." у EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA.
 */
export function rewritePlaylist(body: string, playlistUrl: string, wrap: (absolute: string) => string): string {
  const resolve = (ref: string) => new URL(ref, playlistUrl).toString();
  return body
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, ref: string) => `URI="${wrap(resolve(ref))}"`);
      }
      return wrap(resolve(trimmed));
    })
    .join('\n');
}

const BANDWIDTH: Record<number, [number, string]> = {
  480: [1_200_000, '854x480'],
  720: [2_800_000, '1280x720'],
  1080: [5_500_000, '1920x1080'],
};

/** Собирает мастер-плейлист из отдельных плейлистов по качествам — так работает «Авто». */
export function buildMaster(sources: { quality: number; url: string }[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const source of [...sources].sort((a, b) => a.quality - b.quality)) {
    const [bandwidth, resolution] = BANDWIDTH[source.quality] ?? [source.quality * 4000, `${Math.round((source.quality * 16) / 9)}x${source.quality}`];
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${resolution},NAME="${source.quality}p"`);
    lines.push(source.url);
  }
  return `${lines.join('\n')}\n`;
}
