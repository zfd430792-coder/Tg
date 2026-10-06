// Ссылки на встроенные плееры балансеров: нормализация и открытие нужной серии.

/** Ссылки приходят как //host/..., http://... или https://... — приводим к https. */
export function normalizeLink(link: string | null | undefined): string | null {
  if (!link || typeof link !== 'string') return null;
  let url = link.trim();
  if (url.startsWith('//')) url = `https:${url}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Локальный мок для разработки работает по http, всё остальное — только https.
  const local = ['localhost', '127.0.0.1'].includes(parsed.hostname);
  parsed.protocol = local && link.trim().startsWith('//') ? 'http:' : local ? parsed.protocol : 'https:';
  if (!/^https?:$/.test(parsed.protocol)) return null;
  return parsed.toString();
}

export interface FrameOptions {
  params: { season: string | null; episode: string } | null;
  season: string | null;
  episode: number | null;
  /** Убрать свой выбор озвучки у плеера (когда выбираем снаружи). */
  hideDubs?: boolean;
}

/** Адрес iframe для серии. Kodik открывает серию параметрами ?season=&episode=. */
export function frameSrc(link: string, options: FrameOptions): string {
  const url = new URL(link);
  if (options.hideDubs) {
    url.searchParams.set('translations', 'false');
  } else {
    // AniLiberty отдаёт ссылку Kodik с translations=false — тогда меню озвучек пропадает.
    url.searchParams.delete('translations');
    url.searchParams.delete('hide_selectors');
  }
  if (options.params && options.episode !== null) {
    if (options.params.season && options.season) url.searchParams.set(options.params.season, options.season);
    url.searchParams.set(options.params.episode, String(options.episode));
  }
  return url.toString();
}
