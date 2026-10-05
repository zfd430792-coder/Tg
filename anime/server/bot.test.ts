// Бот без сети: вызовы Bot API перехватываются, апдейты подаются вручную.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Release, ReleaseCard } from '../shared/types.ts';
import type { AniLiberty } from './anilibria.ts';
import { createBot } from './bot.ts';

type Call = { method: string; payload: Record<string, any> };

function setup(search: (q: string) => Promise<ReleaseCard[]>) {
  const calls: Call[] = [];
  const api = { search } as unknown as AniLiberty;
  const telegram = createBot({ token: '1:T', siteUrl: 'https://anime.example', appName: 'AniMini', api, log: () => undefined });
  telegram.bot.botInfo = {
    id: 1,
    is_bot: true,
    first_name: 'AniMini',
    username: 'animini_bot',
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: true,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
  } as typeof telegram.bot.botInfo;
  telegram.bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, any> });
    if (method === 'sendPhoto' && (payload as Record<string, any>).chat_id === 403) {
      return { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } as never;
    }
    return { ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: 'private' } } } as never;
  });
  return { telegram, calls };
}

let updateId = 0;
function message(text: string) {
  const entities = text.startsWith('/') ? [{ type: 'bot_command' as const, offset: 0, length: text.split(' ')[0].length }] : undefined;
  return {
    update_id: ++updateId,
    message: { message_id: updateId, date: 0, chat: { id: 7, type: 'private' as const, first_name: 'A' }, from: { id: 7, is_bot: false, first_name: 'A' }, text, entities },
  };
}

const button = (call: Call) => call.payload.reply_markup.inline_keyboard[0][0];

test('/start показывает кнопку Mini App, а с параметром — нужный тайтл', async () => {
  const { telegram, calls } = setup(async () => []);
  await telegram.bot.handleUpdate(message('/start'));
  assert.equal(calls[0].method, 'sendMessage');
  assert.deepEqual(button(calls[0]).web_app, { url: 'https://anime.example/' });

  await telegram.bot.handleUpdate(message('/start w_9000_12p5'));
  assert.deepEqual(button(calls[1]).web_app, { url: 'https://anime.example/watch/9000/12.5' });
});

test('текст без команды — поиск по каталогу', async () => {
  const card = { id: 9013, title: 'Атака титанов', year: 2013 } as ReleaseCard;
  const { telegram, calls } = setup(async (q) => (q === 'титан' ? [card] : []));
  await telegram.bot.handleUpdate(message('титан'));
  assert.equal(button(calls[0]).text, 'Атака титанов (2013)');
  assert.equal(button(calls[0]).web_app.url, 'https://anime.example/release/9013');

  await telegram.bot.handleUpdate(message('нет такого'));
  assert.match(calls[1].payload.text, /Ничего не нашёл/);
});

test('уведомление о новой серии и заблокировавший бота пользователь', async () => {
  const { telegram, calls } = setup(async () => []);
  const release = { id: 9000, title: 'Магическая <битва>', poster: 'https://img/p.jpg' } as Release;
  const episodes = [{ ordinal: 7 }, { ordinal: 8 }] as Release['episodes'];
  assert.equal(await telegram.notify(5, release, episodes), 'ok');
  assert.equal(calls[0].method, 'sendPhoto');
  assert.match(calls[0].payload.caption, /серии 7–8 «<b>Магическая &lt;битва&gt;<\/b>»/);
  assert.equal(button(calls[0]).web_app.url, 'https://anime.example/watch/9000/8');
  assert.equal(await telegram.notify(403, release, episodes), 'blocked');
});
