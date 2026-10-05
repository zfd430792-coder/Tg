// Маленький роутер на History API: несколько страниц, параметры в пути,
// глубина истории для кнопки «Назад» Telegram и восстановление прокрутки.

import { createElement, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

interface HistoryState {
  depth: number;
  key: string;
}

export interface Location {
  path: string;
  query: URLSearchParams;
  depth: number;
  key: string;
  /** Пришли сюда кнопкой «Назад»/«Вперёд» — тогда возвращаем прокрутку. */
  pop: boolean;
}

const listeners = new Set<() => void>();
const scrolls = new Map<string, number>();
const newKey = () => Math.random().toString(36).slice(2, 10);

function state(): HistoryState {
  const s = history.state as HistoryState | null;
  if (s && typeof s.depth === 'number' && s.key) return s;
  const initial = { depth: 0, key: newKey() };
  history.replaceState(initial, '');
  return initial;
}

function read(pop: boolean): Location {
  const s = state();
  return { path: location.pathname, query: new URLSearchParams(location.search), depth: s.depth, key: s.key, pop };
}

let current = read(false);
history.scrollRestoration = 'manual';

function emit(pop: boolean) {
  current = read(pop);
  listeners.forEach((listener) => listener());
}

window.addEventListener('popstate', () => emit(true));

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (to === location.pathname + location.search) return;
  scrolls.set(current.key, window.scrollY);
  const depth = options.replace ? current.depth : current.depth + 1;
  const next: HistoryState = { depth, key: newKey() };
  if (options.replace) history.replaceState(next, '', to);
  else history.pushState(next, '', to);
  emit(false);
}

/** Меняет параметры запроса без новой записи в истории (фильтры, поиск). */
export function setQuery(params: Record<string, string | null | undefined>): void {
  const query = new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') query.delete(key);
    else query.set(key, value);
  }
  const search = query.toString();
  history.replaceState(history.state, '', `${location.pathname}${search ? `?${search}` : ''}`);
  current = { ...read(false), key: current.key };
  listeners.forEach((listener) => listener());
}

export function goBack(): void {
  if (current.depth > 0) history.back();
  else navigate('/', { replace: true });
}

export function savedScroll(key: string): number {
  return scrolls.get(key) ?? 0;
}

export function useLocation(): Location {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

export function match(pattern: string, path: string): Record<string, string> | null {
  const names: string[] = [];
  const source = pattern.replace(/:(\w+)/g, (_, name: string) => {
    names.push(name);
    return '([^/]+)';
  });
  const found = new RegExp(`^${source}/?$`).exec(path);
  if (!found) return null;
  return Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(found[i + 1])]));
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; replace?: boolean };

export function Link({ to, replace, onClick, ...rest }: LinkProps) {
  return createElement('a', {
    ...rest,
    href: to,
    onClick(event: MouseEvent<HTMLAnchorElement>) {
      onClick?.(event);
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(to, { replace });
    },
  });
}
