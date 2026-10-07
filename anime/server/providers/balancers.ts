// Видеобалансеры кроме Kodik: CVH и Alloha. У них 1080p и много озвучек, а видео
// лежит на их серверах — хранить его самим не нужно. Оба включаются партнёрским
// ID или токеном, который выдаёт сам балансер после регистрации сайта.
//
// Форматы API собраны по открытым клиентам этих балансеров (см. README):
//   CVH     GET https://plapi.cdnvideohub.com/api/v1/player/sv/playlist?pub=ID&aggr=mali&id=<ID Shikimori>
//   Alloha  GET https://api.alloha.tv/?token=<токен>&kp=ID (или &name=<название>&list=1 — поиск)
//           GET https://apbugall.org/v2/movies/search?kp=ID, Authorization: Bearer <токен> — новый API

import { normalizeLink } from '../../shared/players.ts';
import type { Dub, PlayerSource, Release } from '../../shared/types.ts';
import { normalizeName, releaseTarget, searchQueries } from '../torrents/titles.ts';
import { type ExternalIds, qualityOf } from './kodik.ts';

type Raw = Record<string, any>;

export interface Balancer {
  id: string;
  title: string;
  find(release: Release, ids: ExternalIds): Promise<PlayerSource | null>;
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<Raw> {
  const response = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  try {
    return JSON.parse(text) as Raw;
  } catch {
    throw new Error(`${new URL(url).hostname} ответил ${response.status}`);
  }
}

const values = (value: unknown): Raw[] =>
  Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value as Raw) : [];

/** Ответ Alloha: по ID — одна запись, по названию — список. */
const firstItem = (data: unknown): Raw | null => (Array.isArray(data) ? (data[0] ?? null) : data && typeof data === 'object' ? (data as Raw) : null);

const toNumber = (value: unknown): number | null => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function withParam(link: string, key: string, value: string): string {
  const url = new URL(link);
  url.searchParams.set(key, value);
  return url.toString();
}

/**
 * Какой сезон открывать. Сериал на Кинопоиске один на все сезоны, а наш тайтл — один
 * сезон. Если сезонов несколько и какой из них наш, неизвестно, — null: серию выбирают
 * в плеере. Если наш сезон известен, а у балансера его нет — 'missing': плеер не
 * показываем, чтобы не открыть чужой сезон.
 */
export function pickSeason(seasons: Raw[], kpSeason: number | null): number | null | 'missing' {
  const numbers = seasons.map((s) => toNumber(s.season)).filter((n): n is number => n !== null);
  if (kpSeason) return numbers.includes(kpSeason) ? kpSeason : 'missing';
  return numbers.length === 1 ? numbers[0] : null;
}

function lastEpisodeIn(season: Raw | undefined): number | null {
  if (!season) return null;
  const numbers = values(season.episodes)
    .map((e) => toNumber(e.episode))
    .filter((n): n is number => n !== null);
  return numbers.length ? Math.max(...numbers) : toNumber(season.episodes_count);
}

const isSubtitles = (name: string) => /субт|subs?\b/i.test(name);

const byTypeAndEpisodes = (a: Dub, b: Dub) =>
  Number(a.type === 'subtitles') - Number(b.type === 'subtitles') || (b.lastEpisode ?? 0) - (a.lastEpisode ?? 0);

/** Лучшее качество озвучки Alloha: список разрешений, флаг 4K или строка вроде «WEB-DL 1080p». */
function allohaQuality(translation: Raw): number | null {
  const resolutions = values(translation.resolutions)
    .map((r) => toNumber(r))
    .filter((n): n is number => n !== null);
  if (resolutions.length) return Math.max(...resolutions);
  if (translation.uhd === true) return 2160;
  return qualityOf(translation.quality);
}

/**
 * Фильм это или сериал. Категория Alloha: 1 — фильм, 2 — мультфильм, 3 — мультсериал,
 * 4 — сериал, 5 — аниме (бывает и тем, и другим). По ID она в поле category, в списке —
 * в category_id (а category там — слово). null — не понять.
 */
function allohaKind(item: Raw): 'movie' | 'serial' | null {
  const category = toNumber(item.category_id) ?? toNumber(item.category);
  if (category === 1 || category === 2) return 'movie';
  if (category === 3 || category === 4) return 'serial';
  return toNumber(item.last_season) || toNumber(item.seasons_count) || values(item.seasons).length ? 'serial' : null;
}

/**
 * Тайтл AniLibria в каталоге Alloha, найденный по названию: имя совпадает (русское,
 * оригинальное или альтернативное), год подходит, фильм не подменяет сериал. У Alloha
 * сезоны — внутри одной записи, поэтому у 2-го и следующих сезонов запись франшизы
 * может быть на несколько лет старше. Из подходящих — аниме, если есть.
 */
export function pickAllohaItem(items: Raw[], release: Release): Raw | null {
  const target = releaseTarget(release);
  const squeeze = (value: string) => normalizeName(value).replace(/ /g, '');
  const ours = new Set(target.names.map((n) => n.name.replace(/ /g, '')));
  const fits = (item: Raw) => {
    const names = [item.name, item.original_name, item.alternative_name].filter((n): n is string => typeof n === 'string' && n.trim() !== '');
    if (!names.flatMap((n) => [n, n.split(/:\s/)[0]]).some((n) => ours.has(squeeze(n)))) return false;
    const kind = allohaKind(item);
    if (kind && (kind === 'movie') !== target.movie) return false;
    const year = toNumber(item.year);
    if (!release.year || !year) return true;
    return target.season > 1 ? year <= release.year + 1 && year >= release.year - 25 : Math.abs(year - release.year) <= 1;
  };
  const matched = items.filter(fits);
  return matched.find((item) => (toNumber(item.category_id) ?? toNumber(item.category)) === 5) ?? matched[0] ?? null;
}

/**
 * Alloha: 1080p, у части тайтлов 4K. Озвучки выбираются на нашей странице
 * (translation=<id>, hidden=translation прячет их меню). Время просмотра плеер не
 * сообщает, поэтому в историю попадает только то, что серия открыта.
 */
export class Alloha implements Balancer {
  id = 'alloha';
  title = 'Alloha';
  private token: string;
  private base: string;

  constructor(token: string, base: string) {
    this.token = token;
    this.base = base;
  }

  /**
   * Запрос к API. Классический — GET https://api.alloha.tv/?token=…&kp=… (токен в адресе);
   * если в ALLOHA_API задан адрес v2 (…/v2), — /movies/search с токеном в заголовке.
   */
  private async request(params: Record<string, string>): Promise<Raw | null> {
    const query = new URLSearchParams(params).toString();
    const answer = /\/v2$/.test(this.base)
      ? await getJson(`${this.base}/movies/search?${query}`, { authorization: `Bearer ${this.token}` })
      : await getJson(`${this.base}/?token=${encodeURIComponent(this.token)}&${query}`);
    if (answer.status === 'error' || answer.error) return null;
    return answer;
  }

  /** Тайтл в Alloha: по ID Кинопоиска или IMDb, а без них (Kodik без токена, Shikimori недоступен) — по названию. */
  private async lookup(release: Release, ids: ExternalIds): Promise<Raw | null> {
    if (ids.kinopoisk) return firstItem((await this.request({ kp: ids.kinopoisk }))?.data);
    if (ids.imdb) return firstItem((await this.request({ imdb: ids.imdb }))?.data);
    for (const name of searchQueries(release)) {
      const found = pickAllohaItem(values((await this.request({ name, list: '1' }))?.data), release);
      if (!found) continue;
      // В списке бывает не всё (озвучки, ссылки на серии) — полную запись берём по её ID Кинопоиска.
      const kp = toNumber(found.id_kp);
      return (kp && firstItem((await this.request({ kp: String(kp) }))?.data)) || found;
    }
    return null;
  }

  async find(release: Release, ids: ExternalIds): Promise<PlayerSource | null> {
    const data = await this.lookup(release, ids);
    if (!data) return null;
    const iframe = normalizeLink(data.iframe ?? data.iframe_url);
    if (!iframe) return null;

    const seasons = values(data.seasons);
    const picked = pickSeason(seasons, ids.kpSeason ?? (ids.kinopoisk || ids.imdb ? null : releaseTarget(release).season));
    if (seasons.length && picked === 'missing') return null;
    const season = picked === 'missing' ? null : picked;
    const current = seasons.find((s) => toNumber(s.season) === season);

    // Последняя серия каждой озвучки в нашем сезоне.
    const lastByDub = new Map<string, number>();
    for (const episode of values(current?.episodes)) {
      const number = toNumber(episode.episode);
      if (!number) continue;
      const dubs = Array.isArray(episode.translations)
        ? episode.translations.map((t: Raw) => String(t.id))
        : Object.keys(episode.translation ?? episode.translations ?? {});
      for (const id of dubs) lastByDub.set(id, Math.max(lastByDub.get(id) ?? 0, number));
    }

    const translations: { id: string; name: string; quality: number | null }[] = Array.isArray(data.translations)
      ? data.translations.map((t: Raw) => ({ id: String(t.id), name: String(t.name ?? '').trim(), quality: allohaQuality(t) }))
      : Object.entries(data.translation_iframe ?? {}).map(([id, t]) => ({
          id,
          name: String((t as Raw).name ?? '').trim(),
          quality: allohaQuality(t as Raw),
        }));
    const seasonKey = season ? String(season) : null;
    const dubs: Dub[] = translations
      .filter((t) => t.id && t.name)
      // Если известно, какие озвучки есть у серий нашего сезона, остальные не показываем.
      .filter((t) => lastByDub.size === 0 || lastByDub.has(t.id))
      .map((t) => ({
        id: `alloha:${t.id}`,
        title: t.name,
        type: isSubtitles(t.name) ? ('subtitles' as const) : ('voice' as const),
        link: withParam(iframe, 'translation', t.id),
        lastEpisode: seasons.length ? (lastByDub.get(t.id) ?? lastEpisodeIn(current)) : 1,
        season: seasonKey,
        quality: t.quality,
      }))
      .sort(byTypeAndEpisodes);

    // Фильм — без параметров серии; сериал — только когда сезон известен.
    const episodeKnown = seasons.length > 0 && season !== null;
    return {
      id: this.id,
      title: this.title,
      kind: 'iframe',
      link: iframe,
      dubs,
      frame: {
        season: episodeKnown ? 'season' : null,
        episode: episodeKnown ? 'episode' : null,
        hideDubs: { hidden: 'translation' },
        showDubs: ['hidden'],
      },
      events: null,
      lastEpisode: seasons.length ? lastEpisodeIn(current) : 1,
      season: seasonKey,
    };
  }
}

/**
 * CVH (CDNVideoHub): плеер — веб-компонент <video-player> из их SDK, видео — с серверов
 * VK. Аниме ищет по ID MyAnimeList (он же ID Shikimori, есть в AniLiberty), остальное —
 * по Кинопоиску. Плеер показываем на своей странице /embed/cvh на отдельном поддомене
 * (см. cvhPage). Озвучки и число серий берём из того же API, к которому ходит SDK:
 * 204 — тайтла нет.
 */
export class Cvh implements Balancer {
  id = 'cvh';
  title = 'CVH';
  private publisherId: string;
  private base: string;
  private playerUrl: string;

  /** playerUrl — поддомен для плеера (https://player.example.com): по нему CVH узнаёт партнёра. */
  constructor(publisherId: string, base: string, playerUrl: string) {
    this.publisherId = publisherId;
    this.base = base;
    this.playerUrl = playerUrl;
  }

  async find(_release: Release, ids: ExternalIds): Promise<PlayerSource | null> {
    const aggr = ids.shikimori ? 'mali' : ids.kinopoisk ? 'kp' : null;
    const id = ids.shikimori ?? ids.kinopoisk;
    if (!aggr || !id || !/^\d{1,10}$/.test(id)) return null;
    const link = `${this.playerUrl}/embed/cvh?aggr=${aggr}&id=${id}`;
    const query = new URLSearchParams({ pub: this.publisherId, aggr, id });
    const response = await fetch(`${this.base}/player/sv/playlist?${query}`, {
      headers: { accept: 'application/json', referer: `${this.playerUrl}/` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 204 || response.status === 404) return null;
    // Если с сервера в API не пускают, список озвучек не покажем: плеер в браузере
    // всё равно откроется с нашего домена, и озвучку выберут в его меню.
    if (response.status === 401 || response.status === 403) return this.player(link, [], null, null, aggr === 'mali');
    if (!response.ok) throw new Error(`CVH ответил ${response.status}`);
    const data = (await response.json()) as Raw;
    const items = values(data.items);
    if (items.length === 0) return null;

    // У MyAnimeList свой ID на каждый сезон, у Кинопоиска — один на весь сериал.
    const seasonList = [...new Set(items.map((i) => toNumber(i.season)).filter((n): n is number => n !== null))].map((season) => ({ season }));
    const picked = pickSeason(seasonList, aggr === 'kp' ? ids.kpSeason : null);
    if (seasonList.length && picked === 'missing') return null;
    const season = picked === 'missing' ? null : picked;
    const serial = data.isSerial !== false && items.some((i) => toNumber(i.episode) !== null);

    const lastByVoice = new Map<string, number>();
    for (const item of items) {
      if (season !== null && toNumber(item.season) !== season) continue;
      const voice = String(item.voiceStudio || 'Озвучка').trim().slice(0, 80);
      lastByVoice.set(voice, Math.max(lastByVoice.get(voice) ?? 0, toNumber(item.episode) ?? 1));
    }
    const dubs: Dub[] = [...lastByVoice]
      .map(([title, last]) => ({
        id: `cvh:${title}`,
        title,
        type: isSubtitles(title) ? ('subtitles' as const) : ('voice' as const),
        link: `${link}&voice=${encodeURIComponent(title)}`,
        lastEpisode: serial ? last : 1,
        season: season === null ? null : String(season),
        quality: null,
      }))
      .sort(byTypeAndEpisodes);
    // Серию подставляем, только если понятно, какой это сезон (и это не фильм).
    const episodeKnown = serial && (seasonList.length <= 1 || season !== null);
    const lastEpisode = serial ? Math.max(0, ...dubs.map((d) => d.lastEpisode ?? 0)) || null : 1;
    return this.player(link, dubs, season, lastEpisode, episodeKnown);
  }

  private player(link: string, dubs: Dub[], season: number | null, lastEpisode: number | null, episodeKnown: boolean): PlayerSource {
    return {
      id: this.id,
      title: this.title,
      kind: 'iframe',
      link,
      dubs,
      frame: {
        season: season !== null && episodeKnown ? 'season' : null,
        episode: episodeKnown ? 'episode' : null,
        hideDubs: { only: '1' },
        showDubs: ['only'],
      },
      events: 'kodik',
      lastEpisode,
      season: season === null ? null : String(season),
    };
  }
}

const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Только строковые параметры: ?voice=a&voice=b приходит массивом. */
export function stringQuery(query: unknown): Record<string, string | undefined> {
  const entries = Object.entries((query ?? {}) as Record<string, unknown>);
  return Object.fromEntries(entries.map(([key, value]) => [key, typeof value === 'string' ? value : undefined]));
}

/**
 * Страница-обёртка для CVH: их SDK встраивается скриптом, а не ссылкой. Её отдаём только
 * с отдельного поддомена (см. config.playerUrl): там у скриптов CVH свой origin, и до
 * данных приложения (вход через Telegram, localStorage, DOM) браузер их не пустит.
 * События веб-компонента (currentTime, playComplete…) пересылаем приложению в формате
 * Kodik — так прогресс сохраняется так же, как у Kodik.
 */
export function cvhPage(query: Record<string, string | undefined>, publisherId: string, sdk: string, appOrigin: string | null): string | null {
  const aggr = query.aggr ?? '';
  const id = query.id ?? '';
  if (!['mali', 'kp'].includes(aggr) || !/^\d{1,10}$/.test(id)) return null;
  const attrs: Record<string, string> = {
    'data-publisher-id': publisherId,
    'data-aggregator': aggr,
    'data-title-id': id,
    ident: `cvh-${aggr}-${id}`,
  };
  if (query.season && /^\d{1,3}$/.test(query.season)) attrs.season = query.season;
  if (query.episode && /^\d{1,4}$/.test(query.episode)) attrs.episode = query.episode;
  const voice = query.voice?.trim();
  if (voice && voice.length <= 80 && !/[\u0000-\u001f]/.test(voice)) {
    // priority-voice выбирает озвучку, only-voice оставляет в плеере только её.
    attrs['priority-voice'] = voice;
    if (query.only === '1') attrs['only-voice'] = voice;
  }
  const element = Object.entries(attrs)
    .map(([key, value]) => `${key}="${escapeAttr(value)}"`)
    .join(' ');
  const target = JSON.stringify(appOrigin ?? '*').replace(/</g, '\\u003c');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;height:100%;background:#000}video-player{display:block;width:100%;height:100%}</style></head>
<body><video-player ${element}></video-player>
<script>
(function () {
  var el = document.querySelector('video-player');
  var send = function (key, value) { parent.postMessage({ key: key, value: value }, ${target}); };
  var num = function (v) { if (v && typeof v === 'object') v = v.number || v.episodeNumber || v.seasonNumber; var n = Number(v); return n > 0 ? n : null; };
  var episode = num(el.getAttribute('episode'));
  var season = num(el.getAttribute('season'));
  var track = function (s, e) {
    e = num(e);
    if (!e || e === episode) return;
    episode = e;
    season = num(s) || season;
    send('kodik_player_current_episode', { episode: episode, season: season });
  };
  el.addEventListener('currentTime', function (e) { send('kodik_player_time_update', e.detail && e.detail.time); });
  el.addEventListener('durationChange', function (e) { send('kodik_player_duration_update', e.detail && e.detail.duration); });
  el.addEventListener('playComplete', function () { send('kodik_player_video_ended'); });
  el.addEventListener('episodeChange', function (e) { if (e.detail) track(e.detail.seasonNumber, e.detail.episodeNumber); });
  // Серию, выбранную в меню плеера, SDK отдельным событием не сообщает — смотрим состояние.
  el.addEventListener('changeState', function (e) {
    if (e.detail && e.detail.state === 'paused') send('kodik_player_pause');
    try { var state = el.api.getState(); track(state.currentSeason, state.currentEpisode); } catch (error) {}
  });
})();
</script>
<script src="${escapeAttr(sdk)}" async></script></body></html>`;
}
