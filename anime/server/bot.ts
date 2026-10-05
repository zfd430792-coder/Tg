// Telegram-бот: открывает Mini App, ищет тайтлы прямо в чате и присылает
// уведомления о новых сериях. Вся остальная логика живёт в веб-приложении.

import { Bot, GrammyError, InlineKeyboard } from 'grammy';
import { releasePath, startParamToPath, watchPath } from '../shared/links.ts';
import type { Episode, Release } from '../shared/types.ts';
import type { AniLiberty } from './anilibria.ts';
import type { SendResult } from './notifier.ts';

export interface BotDeps {
  token: string;
  siteUrl: string;
  appName: string;
  api: AniLiberty;
  log: (message: string, error?: unknown) => void;
}

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function episodesLabel(episodes: Episode[]): string {
  if (episodes.length === 1) return `${episodes[0].ordinal} серия`;
  return `серии ${episodes[0].ordinal}–${episodes[episodes.length - 1].ordinal}`;
}

export function createBot(deps: BotDeps) {
  const bot = new Bot(deps.token);
  const url = (path = '/') => `${deps.siteUrl}${path}`;
  const open = (path = '/', text = 'Открыть') => new InlineKeyboard().webApp(text, url(path));

  bot.command('start', async (ctx) => {
    const path = startParamToPath(ctx.match);
    if (path) {
      await ctx.reply('Открываю 👇', { reply_markup: open(path, 'Смотреть') });
      return;
    }
    await ctx.reply(
      `Привет! Это <b>${escape(deps.appName)}</b> — аниме с русской озвучкой прямо в Telegram.\n\n` +
        'Открой приложение кнопкой ниже или просто напиши название — найду.',
      { parse_mode: 'HTML', reply_markup: open('/', 'Смотреть аниме') },
    );
  });

  bot.command('help', (ctx) =>
    ctx.reply(
      'Что я умею:\n' +
        '• напиши название — покажу, что нашлось;\n' +
        '• в приложении нажми 🔔 у тайтла — пришлю, когда выйдет новая серия;\n' +
        '• /start — открыть приложение.',
    ),
  );

  bot.on('message:text', async (ctx) => {
    const query = ctx.message.text.trim();
    if (query.startsWith('/') || query.length < 2) return;
    let found;
    try {
      found = await deps.api.search(query);
    } catch (error) {
      deps.log('Поиск из бота не удался', error);
      await ctx.reply('Каталог сейчас не отвечает, попробуй чуть позже.');
      return;
    }
    if (found.length === 0) {
      await ctx.reply('Ничего не нашёл 😔 Попробуй другое название или открой каталог.', { reply_markup: open('/catalog', 'Каталог') });
      return;
    }
    const keyboard = new InlineKeyboard();
    for (const card of found.slice(0, 8)) {
      const year = card.year ? ` (${card.year})` : '';
      keyboard.webApp(`${card.title}${year}`, url(releasePath(card.id))).row();
    }
    await ctx.reply(`Нашёл ${found.length > 8 ? 'много, вот первые 8' : found.length}:`, { reply_markup: keyboard });
  });

  bot.catch((error) => deps.log('Ошибка в обработчике бота', error.error));

  async function setup() {
    await bot.api.setMyCommands([
      { command: 'start', description: 'Открыть приложение' },
      { command: 'help', description: 'Что умеет бот' },
    ]);
    await bot.api.setChatMenuButton({
      menu_button: { type: 'web_app', text: 'Смотреть', web_app: { url: url('/') } },
    });
  }

  async function notify(userId: number, release: Release, episodes: Episode[]): Promise<SendResult> {
    const newest = episodes[episodes.length - 1];
    const caption = `🔔 Вышла ${episodesLabel(episodes)} «<b>${escape(release.title)}</b>»`;
    const reply_markup = open(watchPath(release.id, newest.ordinal), '▶️ Смотреть');
    try {
      if (release.poster) {
        await bot.api.sendPhoto(userId, release.poster, { caption, parse_mode: 'HTML', reply_markup });
      } else {
        await bot.api.sendMessage(userId, caption, { parse_mode: 'HTML', reply_markup });
      }
      return 'ok';
    } catch (error) {
      if (error instanceof GrammyError && error.error_code === 403) return 'blocked';
      if (error instanceof GrammyError && release.poster && error.error_code === 400) {
        // Telegram не смог скачать постер — отправим без картинки.
        try {
          await bot.api.sendMessage(userId, caption, { parse_mode: 'HTML', reply_markup });
          return 'ok';
        } catch {
          // упадём в общий лог ниже
        }
      }
      deps.log(`Не удалось отправить уведомление ${userId}`, error);
      return 'error';
    }
  }

  return { bot, setup, notify };
}
