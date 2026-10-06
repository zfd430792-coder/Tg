// Видеобалансеры кроме Kodik: CVH и Alloha. У них 1080p и много озвучек, а видео
// лежит на их серверах — хранить его самим не нужно. Оба включаются партнёрским
// ID или токеном, который выдаёт сам балансер после регистрации сайта.
//
// Форматы API собраны по открытым клиентам этих балансеров (см. README):
//   CVH     GET https://plapi.cdnvideohub.com/api/v1/player/sv/playlist?pub=ID&aggr=mali&id=<ID Shikimori>
//   Alloha  GET https://apbugall.org/v2/movies/search?kp=ID, Authorization: Bearer <токен>

import { normalizeLink } from '../../shared/players.ts';
import type { Dub, PlayerSource, Release } from '../../shared/types.ts';
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

  async find(_release: Release, ids: ExternalIds): Promise<PlayerSource | null> {
    const query = ids.kinopoisk ? `kp=${ids.kinopoisk}` : ids.imdb ? `imdb=${ids.imdb}` : null;
    if (!query) return null;
    const answer = await getJson(`${this.base}/movies/search?${query}`, { authorization: `Bearer ${this.token}` });
    if (answer.status === 'error' || answer.error) return null;
    const data = answer.data ?? {};
    const iframe = normalizeLink(data.iframe ?? data.iframe_url);
    if (!iframe) return null;

    const seasons = values(data.seasons);
    const picked = pickSeason(seasons, ids.kpSeason);
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
 * по Кинопоиску. Плеер показываем на своей странице /embed/cvh (см. cvhPage). Озвучки и
 * число серий берём из того же API, к которому ходит SDK: 204 — тайтла нет.
 */
export class Cvh implements Balancer {
  id = 'cvh';
  title = 'CVH';
  private publisherId: string;
  private base: string;
  private referer: string | null;

  /** referer — адрес нашего сайта: доступ к API CVH привязан к домену сайта партнёра. */
  constructor(publisherId: string, base: string, referer: string | null) {
    this.publisherId = publisherId;
    this.base = base;
    this.referer = referer;
  }

  async find(_release: Release, ids: ExternalIds): Promise<PlayerSource | null> {
    const aggr = ids.shikimori ? 'mali' : ids.kinopoisk ? 'kp' : null;
    const id = ids.shikimori ?? ids.kinopoisk;
    if (!aggr || !id || !/^\d{1,10}$/.test(id)) return null;
    const link = `/embed/cvh?aggr=${aggr}&id=${id}`;
    const query = new URLSearchParams({ pub: this.publisherId, aggr, id });
    const response = await fetch(`${this.base}/player/sv/playlist?${query}`, {
      headers: { accept: 'application/json', ...(this.referer ? { referer: `${this.referer}/` } : {}) },
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

/**
 * Страница-обёртка для CVH: их SDK встраивается скриптом, а не ссылкой. Она открыта с
 * нашего домена, как у AnimeGo и YummyAnime: по домену CVH узнаёт сайт партнёра.
 * События веб-компонента (currentTime, playComplete…) пересылаем родителю в формате
 * Kodik — так прогресс сохраняется так же, как у Kodik.
 */
export function cvhPage(query: Record<string, string | undefined>, publisherId: string, sdk: string): string | null {
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
  if (voice && voice.length <= 80 && !/[\u0000-\u001f]/.test(voice)) attrs[query.only === '1' ? 'only-voice' : 'priority-voice'] = voice;
  const element = Object.entries(attrs)
    .map(([key, value]) => `${key}="${escapeAttr(value)}"`)
    .join(' ');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;height:100%;background:#000}video-player{display:block;width:100%;height:100%}</style></head>
<body><video-player ${element}></video-player>
<script>
(function () {
  // Скрипты CVH работают на нашем домене. Чтобы они не видели данные приложения (вход
  // через Telegram, историю) и не сорили в них, даём им пустые хранилища в памяти.
  // От целенаправленного чтения через parent это не защищает, но обычные скрипты
  // плеера и аналитики данных сайта не увидят.
  var memory = function () {
    var data = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[k] = String(v); },
      removeItem: function (k) { delete data[k]; },
      clear: function () { data = {}; },
      key: function (i) { return Object.keys(data)[i] || null; },
      get length() { return Object.keys(data).length; }
    };
  };
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    try { Object.defineProperty(window, name, { value: memory(), configurable: true }); } catch (error) {}
  });

  var el = document.querySelector('video-player');
  var send = function (key, value) { parent.postMessage({ key: key, value: value }, location.origin); };
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
