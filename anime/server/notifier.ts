// Уведомления о новых сериях. Раз в несколько минут смотрим ленту последних
// обновлений AniLiberty и для тайтлов, на которые кто-то подписан, сравниваем
// номер последней серии с тем, что видели в прошлый раз.

import type { Episode, Release, ReleaseCard } from '../shared/types.ts';
import type { Store } from './db.ts';

export type SendResult = 'ok' | 'blocked' | 'error';

export interface NotifierDeps {
  store: Store;
  latest: () => Promise<ReleaseCard[]>;
  release: (id: number) => Promise<Release>;
  send: (userId: number, release: Release, episodes: Episode[]) => Promise<SendResult>;
  log?: (message: string, error?: unknown) => void;
}

export function lastOrdinal(release: Release): number {
  return release.episodes.reduce((max, e) => Math.max(max, e.ordinal), 0);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Notifier {
  private deps: NotifierDeps;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(deps: NotifierDeps) {
    this.deps = deps;
  }

  /** Запоминает текущую последнюю серию, чтобы первая проверка не приняла старые серии за новые. */
  seed(release: Release): void {
    if (!this.deps.store.releaseState(release.id)) {
      this.deps.store.setReleaseState(release.id, release.freshAt, lastOrdinal(release));
    }
  }

  start(intervalMs: number): void {
    const run = () => {
      this.tick().catch((error) => this.deps.log?.('Проверка новых серий не удалась', error));
    };
    this.timer = setInterval(run, intervalMs);
    setTimeout(run, 15_000).unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Возвращает, сколько уведомлений отправлено. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.check();
    } finally {
      this.running = false;
    }
  }

  private async check(): Promise<number> {
    const { store } = this.deps;
    const subscribed = store.subscribedReleaseIds();
    if (subscribed.size === 0) return 0;

    let sent = 0;
    for (const card of await this.deps.latest()) {
      if (!subscribed.has(card.id)) continue;
      const state = store.releaseState(card.id);
      if (state && state.freshAt === card.freshAt) continue;

      const release = await this.deps.release(card.id);
      const last = lastOrdinal(release);
      if (state && last > state.lastOrdinal) {
        const fresh = release.episodes.filter((e) => e.ordinal > state.lastOrdinal);
        for (const userId of store.subscribers(card.id)) {
          const result = await this.deps.send(userId, release, fresh);
          if (result === 'ok') sent += 1;
          if (result === 'blocked') store.markBlocked(userId);
          // Telegram разрешает около 30 сообщений в секунду.
          await pause(50);
        }
      }
      store.setReleaseState(card.id, card.freshAt, Math.max(last, state?.lastOrdinal ?? 0));
    }
    return sent;
  }
}
