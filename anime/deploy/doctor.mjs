// Часть проверок `animini doctor`, которую удобнее делать из контейнера
// приложения: там есть Node, fetch и токен бота. Запуск:
//   docker compose exec -T app node --input-type=module - < deploy/doctor.mjs
// Токен в вывод не попадает.

const site = (process.env.SITE_URL ?? '').replace(/\/+$/, '');
const token = process.env.BOT_TOKEN ?? '';

const mark = (state, text) => console.log(`  ${state === true ? '✓' : state === false ? '✗' : '·'} ${text}`);
const getJson = async (url, headers = {}) => {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${new URL(url).hostname} ответил ${response.status}: ${text.slice(0, 80).trim()}`);
  }
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log('Бот');
try {
  const me = await getJson(`https://api.telegram.org/bot${token}/getMe`);
  if (!me.ok) {
    mark(false, `Telegram не принял токен: ${me.description}`);
  } else {
    mark(true, `@${me.result.username}`);
    const menu = await getJson(`https://api.telegram.org/bot${token}/getChatMenuButton`);
    const button = menu.result ?? {};
    if (button.type === 'web_app') {
      const same = button.web_app.url.startsWith(site);
      mark(same, `кнопка «${button.text}» открывает ${button.web_app.url}${same ? '' : ` — а сайт сейчас ${site}, выполните: sudo animini restart`}`);
    } else {
      mark(false, `кнопка меню не открывает Mini App (${button.type ?? menu.description}) — выполните: sudo animini restart`);
    }
  }
} catch (error) {
  mark(false, `api.telegram.org недоступен с сервера: ${error.message}`);
}

console.log('Сайт снаружи (check-host.net)');
try {
  const headers = { accept: 'application/json' };
  const start = await getJson(`https://check-host.net/check-http?host=${encodeURIComponent(`${site}/api/health`)}&max_nodes=40`, headers);
  if (!start.request_id || !start.nodes) throw new Error(JSON.stringify(start).slice(0, 160));
  const nodes = Object.keys(start.nodes);

  let result = {};
  for (let i = 0; i < 10; i++) {
    await pause(3000);
    result = await getJson(`https://check-host.net/check-result/${start.request_id}`, headers);
    if (nodes.every((node) => result[node] != null)) break;
  }

  const rows = nodes.map((node) => {
    const [country, , city] = start.nodes[node];
    const answer = Array.isArray(result[node]) ? result[node][0] : null;
    const ok = Array.isArray(answer) && answer[0] === 1;
    const detail = !Array.isArray(answer)
      ? 'нет ответа'
      : ok
        ? `HTTP ${answer[3]} за ${Number(answer[1]).toFixed(1)} с`
        : String(answer[2] ?? answer[3] ?? 'ошибка');
    return { ru: country === 'ru', ok, text: `${start.nodes[node][1]}, ${city}: ${detail}` };
  });

  const ru = rows.filter((r) => r.ru);
  const other = rows.filter((r) => !r.ru);
  for (const row of ru) mark(row.ok, row.text);
  if (ru.length === 0) mark(null, 'узлов в России в этот раз не было');
  const okOther = other.filter((r) => r.ok).length;
  mark(okOther === other.length ? true : okOther > 0 ? null : false, `другие страны: открылось с ${okOther} из ${other.length}`);
  for (const row of other.filter((r) => !r.ok).slice(0, 4)) mark(false, row.text);
  console.log(`    подробно: ${start.permanent_link}`);
} catch (error) {
  mark(null, `проверить снаружи не получилось: ${error.message}`);
}
