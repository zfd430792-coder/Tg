// Какой плеер и какую озвучку показывать. Выбор запоминается для каждого тайтла,
// а последний выбор вообще — как запасной для новых тайтлов (любимая студия).

import type { Dub, PlayerSource } from '../../shared/types.ts';

export interface Choice {
  player: string;
  dub: string | null;
}

interface Last {
  player: string;
  dubTitle: string | null;
}

const KEY = 'am:players';
const LAST = 'am:players:last';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // нет места или запрещено — просто не запоминаем
  }
}

export function savedChoice(releaseId: number): Choice | null {
  return read<Record<string, Choice>>(KEY, {})[releaseId] ?? null;
}

export function saveChoice(releaseId: number, choice: Choice, dubTitle: string | null): void {
  const all = read<Record<string, Choice>>(KEY, {});
  all[releaseId] = choice;
  const keys = Object.keys(all);
  if (keys.length > 500) for (const key of keys.slice(0, keys.length - 500)) delete all[key];
  write(KEY, all);
  write(LAST, { player: choice.player, dubTitle } satisfies Last);
}

/** Плеер и озвучка: сохранённые для тайтла → последние выбранные → первые в списке. */
export function resolveChoice(players: PlayerSource[], choice: Choice | null): { player: PlayerSource; dub: Dub | null } | null {
  if (players.length === 0) return null;
  const last = read<Last | null>(LAST, null);
  const player =
    (choice && players.find((p) => p.id === choice.player)) || (last && players.find((p) => p.id === last.player)) || players[0];
  if (player.dubs.length === 0) return { player, dub: null };
  const dub =
    (choice?.player === player.id && player.dubs.find((d) => d.id === choice.dub)) ||
    (last?.dubTitle && player.dubs.find((d) => d.title === last.dubTitle)) ||
    player.dubs[0];
  return { player, dub };
}
