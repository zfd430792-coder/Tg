// Запросы к своему серверу. Ответы кэшируются в памяти: при возврате назад
// страница рисуется сразу из кэша, без мигания загрузкой.

import { useCallback, useEffect, useState } from 'react';
import type { AppConfig } from '../../shared/types.ts';
import { initData } from './telegram.ts';

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (initData) headers.set('authorization', `tma ${initData}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError(0, 'Нет соединения с сервером');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, data?.error ?? `Ошибка ${response.status}`);
  return data as T;
}

interface Entry {
  data?: unknown;
  error?: ApiError;
  at: number;
  promise?: Promise<unknown>;
}

const cache = new Map<string, Entry>();

function load(url: string): Promise<unknown> {
  const entry = cache.get(url) ?? { at: 0 };
  if (entry.promise) return entry.promise;
  entry.promise = api(url)
    .then((data) => {
      cache.set(url, { data, at: Date.now() });
      return data;
    })
    .catch((error: ApiError) => {
      // При обновлении в фоне старые данные не теряем: ошибка — только если показать нечего.
      const previous = cache.get(url);
      cache.set(url, previous?.data !== undefined ? { data: previous.data, at: previous.at } : { error, at: Date.now() });
      throw error;
    });
  cache.set(url, entry);
  return entry.promise;
}

export function invalidate(prefix: string): void {
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
}

export function prefetch(url: string): void {
  if (!cache.has(url)) load(url).catch(() => undefined);
}

export interface FetchState<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  reload: () => void;
  /** Обновить в фоне: пока идёт запрос, показываем старые данные. */
  refresh: () => void;
}

export function useFetch<T>(url: string | null, ttlMs = 5 * 60_000): FetchState<T> {
  const read = () => (url ? cache.get(url) : undefined);
  const [, setTick] = useState(0);
  const entry = read();

  useEffect(() => {
    if (!url) return;
    const current = cache.get(url);
    const fresh = current && !current.promise && Date.now() - current.at < ttlMs && current.data !== undefined;
    if (fresh) return;
    let alive = true;
    load(url)
      .catch(() => undefined)
      .finally(() => alive && setTick((t) => t + 1));
    return () => {
      alive = false;
    };
  }, [url, ttlMs]);

  const reload = useCallback(() => {
    if (!url) return;
    cache.delete(url);
    setTick((t) => t + 1);
    load(url)
      .catch(() => undefined)
      .finally(() => setTick((t) => t + 1));
  }, [url]);

  const refresh = useCallback(() => {
    if (!url) return;
    load(url)
      .catch(() => undefined)
      .finally(() => setTick((t) => t + 1));
  }, [url]);

  return {
    data: entry?.data as T | undefined,
    error: entry?.data === undefined ? entry?.error : undefined,
    loading: Boolean(url) && entry?.data === undefined && !entry?.error,
    reload,
    refresh,
  };
}

let configPromise: Promise<AppConfig> | null = null;

export function getConfig(): Promise<AppConfig> {
  configPromise ??= api<AppConfig>('/api/config').catch(() => ({
    appName: 'AniMini',
    botUsername: null,
    appShortName: null,
    siteUrl: null,
    authEnabled: false,
  }));
  return configPromise;
}
