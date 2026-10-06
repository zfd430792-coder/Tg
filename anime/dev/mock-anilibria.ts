// Мок AniLiberty API для разработки без доступа к настоящему серверу.
// Отдаёт ответы в том же формате, что https://aniliberty.top/api/v1,
// рисует постеры в SVG и раздаёт тестовые HLS из dev/media (см. make-media.sh).
//
//   node dev/mock-anilibria.ts            → http://localhost:4010
//   ANILIBERTY_API=http://localhost:4010/api/v1 ANILIBERTY_MEDIA=http://localhost:4010 npm run dev

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';

const PORT = Number(process.env.MOCK_PORT ?? 4010);
const ORIGIN = process.env.MOCK_ORIGIN ?? `http://localhost:${PORT}`;
const CORS = process.env.MOCK_CORS !== '0';
const MEDIA = path.resolve(import.meta.dirname, 'media');

type Raw = Record<string, any>;

const GENRES = [
  'Экшен', 'Приключения', 'Комедия', 'Драма', 'Фэнтези', 'Романтика', 'Повседневность', 'Сёнен',
  'Сэйнэн', 'Фантастика', 'Мистика', 'Ужасы', 'Спорт', 'Исекай', 'Детектив', 'Психологическое',
].map((name, i) => ({ id: i + 1, name }));

const TITLES: [string, string][] = [
  ['Магическая битва', 'Jujutsu Kaisen'],
  ['Фрирен, провожающая в последний путь', 'Sousou no Frieren'],
  ['Поднятие уровня в одиночку', 'Solo Leveling'],
  ['Монолог фармацевта', 'The Apothecary Diaries'],
  ['Дандадан', 'Dandadan'],
  ['Человек-бензопила', 'Chainsaw Man'],
  ['Семья шпиона', 'Spy x Family'],
  ['Клинок, рассекающий демонов', 'Demon Slayer'],
  ['Подземелье вкусностей', 'Delicious in Dungeon'],
  ['Кайдзю номер восемь', 'Kaiju No. 8'],
  ['Синяя тюрьма: Блю Лок', 'Blue Lock'],
  ['Доктор Стоун', 'Dr. Stone'],
  ['Магия и мускулы', 'Mashle'],
  ['Атака титанов', 'Attack on Titan'],
  ['Стальной алхимик: Братство', 'Fullmetal Alchemist: Brotherhood'],
  ['Тетрадь смерти', 'Death Note'],
  ['Врата Штейна', 'Steins;Gate'],
  ['Моб Психо 100', 'Mob Psycho 100'],
  ['Ванпанчмен', 'One Punch Man'],
  ['Охотник х Охотник', 'Hunter x Hunter'],
  ['Волейбол!!', 'Haikyuu!!'],
  ['Хоримия', 'Horimiya'],
  ['Коносуба', 'KonoSuba'],
  ['О моём перерождении в слизь', 'Tensura'],
  ['Re:Zero. Жизнь с нуля в альтернативном мире', 'Re:Zero'],
  ['Код Гиас', 'Code Geass'],
  ['Моя геройская академия', 'My Hero Academia'],
  ['Агенты времени', 'Link Click'],
  ['Бездомный бог', 'Noragami'],
  ['Токийский гуль', 'Tokyo Ghoul'],
  ['Ковбой Бибоп', 'Cowboy Bebop'],
  ['Евангелион', 'Neon Genesis Evangelion'],
  ['Твоё имя', 'Kimi no Na wa'],
  ['Форма голоса', 'Koe no Katachi'],
  ['Ходячий замок', "Howl's Moving Castle"],
  ['Унесённые призраками', 'Spirited Away'],
];

const TYPES = [
  { value: 'TV', description: 'ТВ' },
  { value: 'ONA', description: 'ONA' },
  { value: 'OVA', description: 'OVA' },
  { value: 'MOVIE', description: 'Фильм' },
];
const SEASONS = [
  { value: 'winter', description: 'Зима' },
  { value: 'spring', description: 'Весна' },
  { value: 'summer', description: 'Лето' },
  { value: 'autumn', description: 'Осень' },
];
const DAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const RATINGS = [
  { value: 'R12_PLUS', label: '12+' },
  { value: 'R16_PLUS', label: '16+' },
  { value: 'R18_PLUS', label: '18+' },
];

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = <T>(items: T[]) => items[Math.floor(rand() * items.length)];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const image = (p: string) => ({ src: p, preview: p, thumbnail: p, optimized: { src: p, preview: p, thumbnail: p } });

function makeEpisode(releaseId: number, n: number): Raw {
  const id = `ep-${releaseId}-${n}`;
  const video = (q: number) => `${ORIGIN}/videos/${q}/index.m3u8?e=${id}`;
  return {
    id,
    name: n % 4 === 0 ? `Серия с названием №${n}` : null,
    ordinal: n,
    sort_order: n,
    opening: n % 5 === 3 ? { start: null, stop: null } : { start: 5, stop: 25 },
    ending: { start: 45, stop: 58 },
    preview: image(`/storage/previews/${releaseId}-${n}.svg`),
    hls_480: video(480),
    hls_720: video(720),
    hls_1080: video(1080),
    duration: 60,
    release_id: releaseId,
    updated_at: new Date(Date.now() - (40 - n) * 86400_000).toISOString(),
  };
}

const releases: Raw[] = TITLES.map(([main, english], i) => {
  const id = 9000 + i;
  const type = i >= 32 ? TYPES[3] : pick(TYPES.slice(0, 3));
  const ongoing = i < 12;
  const total = type.value === 'MOVIE' ? 1 : pick([12, 13, 24, 25]);
  const released = ongoing ? Math.max(1, Math.floor(rand() * (total - 1)) + 1) : total;
  const genres = [...new Set([pick(GENRES), pick(GENRES), pick(GENRES)])];
  return {
    id,
    alias: slug(english),
    type,
    year: ongoing ? 2026 : 2004 + Math.floor(rand() * 21),
    name: { main, english, alternative: null },
    season: pick(SEASONS),
    poster: image(`/storage/posters/${id}.svg`),
    fresh_at: new Date(Date.now() - (ongoing ? i * 3600_000 * 7 : (i + 30) * 86400_000)).toISOString(),
    is_ongoing: ongoing,
    is_in_production: ongoing,
    age_rating: { ...pick(RATINGS), is_adult: false, description: '' },
    publish_day: { value: (i % 7) + 1, description: DAYS[i % 7] },
    description:
      `«${main}» — тестовое описание для локальной разработки. Здесь будет настоящий синопсис из AniLiberty: ` +
      'кто герои, что у них случилось и почему стоит посмотреть. Длинный текст проверяет, как сворачивается описание на странице тайтла.',
    notification: ongoing ? `Серии выходят по ${DAYS[i % 7].toLowerCase().replace(/а$/, 'у')}ам` : null,
    episodes_total: total,
    is_blocked_by_geo: false,
    is_blocked_by_copyrights: false,
    added_in_users_favorites: Math.floor(rand() * 40000),
    average_duration_of_episode: type.value === 'MOVIE' ? 110 : 24,
    genres: genres.map((g) => ({ ...g, image: image('/'), total_releases: 10 })),
    members: [
      { id: `m${id}a`, role: { value: 'voicing', description: 'Озвучка' }, nickname: 'Itashi' },
      { id: `m${id}b`, role: { value: 'voicing', description: 'Озвучка' }, nickname: 'Hekomi' },
      { id: `m${id}c`, role: { value: 'timing', description: 'Тайминг' }, nickname: 'Sharon' },
    ],
    external_player: `${ORIGIN.replace(/^https?:/, '')}/kodik/serial/${id}/base/720p?translations=false`,
    // «Доктор Стоун» AniLibria ещё не озвучила — смотреть можно только в других плеерах.
    episodes: i === 11 ? [] : Array.from({ length: released }, (_, n) => makeEpisode(id, n + 1)),
  };
});

const card = (r: Raw) => {
  const { episodes, members, ...rest } = r;
  return rest;
};

function svgPoster(id: number, title: string, label = ''): string {
  const hue = (id * 47) % 360;
  const words = title.split(' ');
  const lines: string[] = [];
  for (const word of words) {
    const last = lines[lines.length - 1];
    if (last && (last + ' ' + word).length <= 14) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  const text = lines
    .slice(0, 5)
    .map((line, i) => `<text x="24" y="${330 + i * 36 - lines.length * 18}" font-size="30" font-weight="700">${line.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="350" height="500" viewBox="0 0 350 500">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,55%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},60%,22%)"/></linearGradient></defs>
<rect width="350" height="500" fill="url(#g)"/><circle cx="270" cy="110" r="70" fill="hsla(${hue},90%,85%,.35)"/>
<g fill="#fff" font-family="DejaVu Sans, Arial, sans-serif">${text}<text x="24" y="470" font-size="18" opacity=".8">${label}</text></g></svg>`;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function paginate(items: Raw[], page: number, limit: number) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return {
    data: items.slice((page - 1) * limit, page * limit).map(card),
    meta: { pagination: { total, count: Math.min(limit, total), per_page: limit, current_page: page, total_pages: totalPages, links: {} } },
  };
}

function catalog(body: Raw) {
  const f = body.f ?? {};
  let items = [...releases];
  if (f.search) {
    const q = String(f.search).toLowerCase();
    items = items.filter((r) => `${r.name.main} ${r.name.english}`.toLowerCase().includes(q));
  }
  if (f.genres?.length) items = items.filter((r) => r.genres.some((g: Raw) => f.genres.includes(g.id)));
  if (f.types?.length) items = items.filter((r) => f.types.includes(r.type.value));
  if (f.years?.from_year) items = items.filter((r) => r.year >= f.years.from_year);
  if (f.years?.to_year) items = items.filter((r) => r.year <= f.years.to_year);
  if (f.publish_statuses?.length === 1) items = items.filter((r) => r.is_ongoing === (f.publish_statuses[0] === 'IS_ONGOING'));
  const sorters: Record<string, (a: Raw, b: Raw) => number> = {
    FRESH_AT_DESC: (a, b) => b.fresh_at.localeCompare(a.fresh_at),
    FRESH_AT_ASC: (a, b) => a.fresh_at.localeCompare(b.fresh_at),
    RATING_DESC: (a, b) => b.added_in_users_favorites - a.added_in_users_favorites,
    RATING_ASC: (a, b) => a.added_in_users_favorites - b.added_in_users_favorites,
    YEAR_DESC: (a, b) => b.year - a.year,
    YEAR_ASC: (a, b) => a.year - b.year,
  };
  items.sort(sorters[f.sorting] ?? sorters.FRESH_AT_DESC);
  return paginate(items, Number(body.page) || 1, Number(body.limit) || 10);
}

// ---- Мок Kodik: API с токеном и страница плеера, которая шлёт события как настоящая ----

const KODIK_TOKEN = 'test-kodik';
const TRANSLATIONS = [
  { id: 609, title: 'AniDUB', type: 'voice', extra: 2 },
  { id: 610, title: 'AniLibria.TV', type: 'voice', extra: 0 },
  { id: 767, title: 'SHIZA Project', type: 'voice', extra: -1 },
  { id: 869, title: 'Субтитры', type: 'subtitles', extra: 2 },
];

function kodikEpisodes(r: Raw, extra: number): number {
  const base = Math.max(r.episodes.length, 1);
  return Math.max(1, Math.min(r.episodes_total ?? base + extra, base + extra));
}

function kodikResult(r: Raw, t: (typeof TRANSLATIONS)[number]): Raw {
  const index = releases.indexOf(r);
  const movie = r.type.value === 'MOVIE';
  return {
    id: `${movie ? 'movie' : 'serial'}-${r.id}${t.id}`,
    type: movie ? 'anime' : 'anime-serial',
    link: `${ORIGIN.replace(/^https?:/, '')}/kodik/serial/${r.id}/t${t.id}/720p`,
    title: r.name.main,
    title_orig: r.name.english,
    other_title: r.name.english,
    year: r.year,
    translation: { id: t.id, title: t.title, type: t.type },
    last_season: movie ? undefined : 1,
    last_episode: movie ? undefined : kodikEpisodes(r, t.extra),
    episodes_count: movie ? undefined : kodikEpisodes(r, t.extra),
    shikimori_id: String(50000 + index),
    kinopoisk_id: String(1000000 + index),
    imdb_id: `tt${7000000 + index}`,
  };
}

function kodikSearch(params: URLSearchParams): Raw {
  if (params.get('token') !== KODIK_TOKEN) return { error: 'Отсутствует или неверный токен' };
  let results: Raw[] = [];
  const link = params.get('player_link');
  const shikimori = params.get('shikimori_id');
  const title = params.get('title')?.toLowerCase();
  if (link) {
    const r = releases.find((x) => x.external_player.replace(/^\/\//, '').replace(/[?#].*$/, '') === link);
    if (r) results = [kodikResult(r, TRANSLATIONS[1])];
  } else if (shikimori) {
    const r = releases[Number(shikimori) - 50000];
    if (r) results = TRANSLATIONS.map((t) => kodikResult(r, t));
  } else if (title) {
    results = releases.filter((r) => r.name.main.toLowerCase().includes(title)).map((r) => kodikResult(r, TRANSLATIONS[0]));
  }
  return { time: '1ms', total: results.length, results };
}

function kodikPage(r: Raw, hash: string): string {
  const t = TRANSLATIONS.find((x) => `t${x.id}` === hash) ?? TRANSLATIONS[1];
  const links = TRANSLATIONS.map((x) => ({ title: x.title, link: `/kodik/serial/${r.id}/t${x.id}/720p` }));
  const total = kodikEpisodes(r, t.extra);
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Kodik (мок)</title>
<style>body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:#101418;color:#fff;font:14px sans-serif}
button{margin:2px;padding:4px 8px} .on{background:#2ea6ff;color:#fff}</style>
<div id="info"></div><div id="time">0</div><div id="dubs"></div><div id="eps"></div>
<script>
const q = new URLSearchParams(location.search);
const episode = Number(q.get('episode') || 1), season = Number(q.get('season') || 1);
const translation = { id: ${t.id}, title: ${JSON.stringify(t.title)} };
document.getElementById('info').textContent = 'Kodik (мок) · ' + translation.title + ' · серия ' + episode;
const post = (key, value) => parent.postMessage(value === undefined ? { key } : { key, value }, '*');
let time = 0;
post('kodik_player_current_episode', { episode, season, translation });
post('kodik_player_duration_update', 60);
setInterval(() => {
  time += 1;
  document.getElementById('time').textContent = time;
  post('kodik_player_time_update', time);
  if (time === 60) post('kodik_player_video_ended');
}, 1000);
addEventListener('message', (e) => {
  if (e.data && e.data.key === 'kodik_player_api' && e.data.value && e.data.value.method === 'seek') time = Number(e.data.value.seconds) || 0;
});
if (q.get('translations') !== 'false' && q.get('hide_selectors') !== 'true') {
  for (const d of ${JSON.stringify(links)}) {
    const b = document.createElement('button');
    b.textContent = d.title; b.className = d.title === translation.title ? 'on' : '';
    b.onclick = () => { location.href = d.link + '?episode=' + episode; };
    document.getElementById('dubs').append(b);
  }
}
if (q.get('hide_selectors') !== 'true') {
  for (let n = 1; n <= ${total}; n++) {
    const b = document.createElement('button');
    b.textContent = n; b.className = n === episode ? 'on ep' : 'ep';
    b.onclick = () => { const p = new URLSearchParams(location.search); p.set('episode', n); location.search = p; };
    document.getElementById('eps').append(b);
  }
}
</script></html>`;
}

function readBody(req: IncomingMessage): Promise<Raw> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function serveMedia(req: IncomingMessage, res: ServerResponse, file: string) {
  const full = path.join(MEDIA, file);
  if (!full.startsWith(MEDIA) || !existsSync(full)) {
    res.writeHead(404).end();
    return;
  }
  const type = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : file.endsWith('.ts') ? 'video/mp2t' : 'video/mp4';
  const headers: Record<string, string | number> = { 'content-type': type, 'content-length': statSync(full).size };
  if (CORS) headers['access-control-allow-origin'] = '*';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else createReadStream(full).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', ORIGIN);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  if (CORS && req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }).end();
    return;
  }

  let m: RegExpExecArray | null;
  if ((m = /^\/storage\/posters\/(\d+)\.svg$/.exec(p))) {
    const r = releases.find((x) => x.id === Number(m![1]));
    res.writeHead(r ? 200 : 404, { 'content-type': 'image/svg+xml' }).end(r ? svgPoster(r.id, r.name.main, r.year) : '');
    return;
  }
  if ((m = /^\/storage\/previews\/(\d+)-(\d+)\.svg$/.exec(p))) {
    res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(svgPoster(Number(m[1]) + Number(m[2]), `Серия ${m[2]}`));
    return;
  }
  if ((m = /^\/videos\/(\d+)\/([\w.]+)$/.exec(p))) {
    serveMedia(req, res, `${m[1]}/${m[2]}`);
    return;
  }

  if (p === '/kodik-api/search' && req.method === 'POST') {
    const body = await new Promise<string>((resolve) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => resolve(data));
    });
    return send(res, 200, kodikSearch(new URLSearchParams(body)));
  }
  if ((m = /^\/kodik\/serial\/(\d+)\/(\w+)\/720p$/.exec(p))) {
    const r = releases.find((x) => x.id === Number(m![1]));
    res.writeHead(r ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' }).end(r ? kodikPage(r, m[2]) : 'нет');
    return;
  }

  // Управление моком из тестов: выпустить новую серию.
  if ((m = /^\/__mock\/add-episode\/(\d+)$/.exec(p)) && req.method === 'POST') {
    const r = releases.find((x) => x.id === Number(m![1]));
    if (!r) return send(res, 404, { error: 'нет релиза' });
    r.episodes.push(makeEpisode(r.id, r.episodes.length + 1));
    r.fresh_at = new Date().toISOString();
    return send(res, 200, { episodes: r.episodes.length });
  }

  const api = p.startsWith('/api/v1') ? p.slice('/api/v1'.length) : null;
  if (api === null) return send(res, 404, { message: 'Not found' });

  if (api === '/anime/releases/latest') {
    const limit = Number(url.searchParams.get('limit')) || 10;
    return send(res, 200, [...releases].sort((a, b) => b.fresh_at.localeCompare(a.fresh_at)).slice(0, limit).map(card));
  }
  if (api === '/anime/releases/random') return send(res, 200, [card(pick(releases))]);
  if (api === '/anime/catalog/releases') {
    const body = req.method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams);
    return send(res, 200, catalog(body));
  }
  if (api === '/anime/catalog/references/genres') return send(res, 200, GENRES);
  if (api === '/anime/catalog/references/types') return send(res, 200, TYPES);
  if (api === '/anime/catalog/references/years') return send(res, 200, [...new Set(releases.map((r) => r.year))].sort());
  if (api === '/anime/catalog/references/sorting') {
    return send(res, 200, ['FRESH_AT_DESC', 'RATING_DESC', 'YEAR_DESC', 'YEAR_ASC'].map((value) => ({ value, label: value, description: '' })));
  }
  if (api === '/app/search/releases') {
    const q = (url.searchParams.get('query') ?? '').toLowerCase();
    return send(res, 200, releases.filter((r) => `${r.name.main} ${r.name.english}`.toLowerCase().includes(q)).map(card));
  }
  if (api === '/anime/schedule/week') {
    return send(res, 200, releases
      .filter((r) => r.is_ongoing)
      .map((r) => ({
        release: card(r),
        full_season_is_released: false,
        published_release_episode: r.episodes[r.episodes.length - 1],
        next_release_episode_number: r.episodes.length + 1,
      })));
  }
  if ((m = /^\/anime\/releases\/episodes\/([\w-]+)$/.exec(api))) {
    for (const r of releases) {
      const episode = r.episodes.find((e: Raw) => e.id === m![1]);
      if (episode) return send(res, 200, { ...episode, release: card(r) });
    }
    return send(res, 404, { message: 'Not found' });
  }
  if ((m = /^\/anime\/releases\/([\w-]+)$/.exec(api))) {
    const r = releases.find((x) => String(x.id) === m![1] || x.alias === m![1]);
    return r ? send(res, 200, r) : send(res, 404, { message: 'Not found' });
  }
  return send(res, 404, { message: 'Not found' });
});

server.listen(PORT, () => console.log(`Мок AniLiberty: ${ORIGIN}/api/v1 (${releases.length} релизов)`));
