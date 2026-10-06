// Данные зрителя. В Telegram они хранятся на сервере (вход по initData),
// в обычном браузере — в localStorage этого устройства. Страницы работают
// с одним интерфейсом и не знают, где лежат данные.

import { useSyncExternalStore } from 'react';
import type { EpisodeProgress, HistoryItem, ProgressInput, ReleaseCard, ReleaseUserState, User } from '../../shared/types.ts';
import { api, getConfig } from './api.ts';
import { initData } from './telegram.ts';

export interface UserData {
  mode: 'telegram' | 'local';
  me(): Promise<User | null>;
  setNotify(on: boolean): Promise<void>;
  releaseState(releaseId: number): Promise<ReleaseUserState>;
  setFavorite(card: ReleaseCard, on: boolean): Promise<void>;
  setSubscribed(releaseId: number, on: boolean): Promise<void>;
  saveProgress(card: ReleaseCard, input: ProgressInput, leaving?: boolean): Promise<void>;
  favorites(): Promise<ReleaseCard[]>;
  subscriptions(): Promise<ReleaseCard[]>;
  history(): Promise<HistoryItem[]>;
}

const remote: UserData = {
  mode: 'telegram',
  me: () => api<User>('/api/me'),
  async setNotify(on) {
    await api('/api/me', { method: 'PATCH', body: JSON.stringify({ notify: on }) });
  },
  releaseState: (id) => api<ReleaseUserState>(`/api/me/releases/${id}`),
  async setFavorite(card, on) {
    await api(`/api/me/favorites/${card.id}`, { method: on ? 'PUT' : 'DELETE' });
  },
  async setSubscribed(id, on) {
    await api(`/api/me/subscriptions/${id}`, { method: on ? 'PUT' : 'DELETE' });
  },
  async saveProgress(_card, input, leaving) {
    if (leaving && navigator.sendBeacon) {
      // При закрытии Mini App обычный fetch может не успеть.
      const blob = new Blob([JSON.stringify({ ...input, initData })], { type: 'application/json' });
      if (navigator.sendBeacon('/api/me/progress', blob)) return;
    }
    await api('/api/me/progress', { method: 'POST', body: JSON.stringify(input), keepalive: leaving });
  },
  favorites: () => api<ReleaseCard[]>('/api/me/favorites'),
  subscriptions: () => api<ReleaseCard[]>('/api/me/subscriptions'),
  history: () => api<HistoryItem[]>('/api/me/history'),
};

// ---- localStorage ----

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // переполнено или запрещено — просто не сохраняем
  }
}

type LocalProgress = EpisodeProgress & { releaseId: number };
const FAVORITES = 'am:favorites';
const PROGRESS = 'am:progress';
const CARDS = 'am:cards';

function rememberCard(card: ReleaseCard) {
  const cards = readJson<Record<number, ReleaseCard>>(CARDS, {});
  cards[card.id] = card;
  writeJson(CARDS, cards);
}

const local: UserData = {
  mode: 'local',
  me: async () => null,
  setNotify: async () => undefined,
  async releaseState(id) {
    const favorites = readJson<{ card: ReleaseCard; at: string }[]>(FAVORITES, []);
    const progress = Object.values(readJson<Record<string, LocalProgress>>(PROGRESS, {}))
      .filter((p) => p.releaseId === id)
      .sort((a, b) => a.ordinal - b.ordinal);
    return { favorite: favorites.some((f) => f.card.id === id), subscribed: false, progress };
  },
  async setFavorite(card, on) {
    const favorites = readJson<{ card: ReleaseCard; at: string }[]>(FAVORITES, []).filter((f) => f.card.id !== card.id);
    if (on) favorites.unshift({ card, at: new Date().toISOString() });
    writeJson(FAVORITES, favorites);
  },
  async setSubscribed() {
    throw new Error('Уведомления о новых сериях приходят через бота — откройте приложение в Telegram');
  },
  async saveProgress(card, input) {
    rememberCard(card);
    const all = readJson<Record<string, LocalProgress>>(PROGRESS, {});
    let previousWatched = Boolean(all[input.episodeId]?.watched);
    // Та же серия под другим ID (см. Store.saveProgress на сервере) — оставляем одну запись.
    for (const [key, p] of Object.entries(all)) {
      if (key === input.episodeId || p.releaseId !== input.releaseId || p.ordinal !== input.ordinal) continue;
      previousWatched ||= Boolean(p.watched);
      delete all[key];
    }
    const watched = Boolean(previousWatched || input.watched || (input.duration > 0 && input.time / input.duration >= 0.92));
    all[input.episodeId] = { ...input, watched, updatedAt: new Date().toISOString() };
    const entries = Object.entries(all);
    if (entries.length > 3000) {
      entries.sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt));
      writeJson(PROGRESS, Object.fromEntries(entries.slice(0, 2000)));
    } else {
      writeJson(PROGRESS, all);
    }
  },
  favorites: async () => readJson<{ card: ReleaseCard }[]>(FAVORITES, []).map((f) => f.card),
  subscriptions: async () => [],
  async history() {
    const cards = readJson<Record<number, ReleaseCard>>(CARDS, {});
    const latest = new Map<number, LocalProgress>();
    for (const p of Object.values(readJson<Record<string, LocalProgress>>(PROGRESS, {}))) {
      const seen = latest.get(p.releaseId);
      if (!seen || seen.updatedAt < p.updatedAt) latest.set(p.releaseId, p);
    }
    return [...latest.values()]
      .filter((p) => cards[p.releaseId])
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 30)
      .map(({ releaseId, ...p }) => ({ ...p, release: cards[releaseId] }));
  },
};

let chosen: UserData = local;

/** Выбирает хранилище: сервер, если мы в Telegram и на сервере настроен бот. */
export async function initUserData(): Promise<UserData> {
  const config = await getConfig();
  chosen = initData && config.authEnabled ? remote : local;
  return chosen;
}

export function userData(): UserData {
  return chosen;
}

// ---- Настройки плеера ----

export interface Settings {
  quality: 'auto' | number;
  autoSkip: boolean;
  autoNext: boolean;
  episodesDesc: boolean;
}

const SETTINGS = 'am:settings';
const defaults: Settings = { quality: 'auto', autoSkip: false, autoNext: true, episodesDesc: false };
let settings: Settings = { ...defaults, ...readJson<Partial<Settings>>(SETTINGS, {}) };
const settingsListeners = new Set<() => void>();

export function getSettings(): Settings {
  return settings;
}

export function updateSettings(patch: Partial<Settings>): void {
  settings = { ...settings, ...patch };
  writeJson(SETTINGS, settings);
  settingsListeners.forEach((listener) => listener());
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (listener) => {
      settingsListeners.add(listener);
      return () => settingsListeners.delete(listener);
    },
    () => settings,
  );
}
