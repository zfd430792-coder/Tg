// Ссылки на встроенные плееры балансеров: нормализация и открытие нужной серии.

import type { FrameParams } from './types.ts';

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
  params: FrameParams;
  season: string | null;
  episode: number | null;
  /** Убрать свой выбор озвучки у плеера (когда выбираем снаружи). */
  hideDubs?: boolean;
}

/** Адрес iframe для серии: параметры сезона/серии и показ или скрытие меню озвучек плеера. */
export function frameSrc(link: string, options: FrameOptions): string {
  // Ссылка бывает и своей, относительной (/embed/cvh?...) — тогда и возвращаем относительную.
  const relative = link.startsWith('/') && !link.startsWith('//');
  const url = new URL(link, 'http://relative.invalid');
  const { params } = options;
  if (options.hideDubs && params.hideDubs) {
    for (const [key, value] of Object.entries(params.hideDubs)) url.searchParams.set(key, value);
  } else {
    // Например, AniLiberty отдаёт ссылку Kodik с translations=false — тогда меню озвучек пропадает.
    for (const key of params.showDubs) url.searchParams.delete(key);
  }
  if (params.episode && options.episode !== null) {
    if (params.season && options.season) url.searchParams.set(params.season, options.season);
    url.searchParams.set(params.episode, String(options.episode));
  }
  return relative ? `${url.pathname}${url.search}` : url.toString();
}
