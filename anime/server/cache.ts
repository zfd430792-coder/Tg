// Кэш ответов чужого API: одинаковые запросы склеиваются в один, а если
// источник упал — отдаём последний удачный ответ, пока он не появится снова.

interface Entry<T> {
  expires: number;
  promise: Promise<T>;
  value?: T;
}

export class TtlCache {
  private entries = new Map<string, Entry<unknown>>();
  private max: number;

  constructor(max = 1000) {
    this.max = max;
  }

  get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const current = this.entries.get(key) as Entry<T> | undefined;
    if (current && current.expires > now) {
      this.entries.delete(key);
      this.entries.set(key, current);
      return current.promise;
    }

    const entry: Entry<T> = { expires: now + ttlMs, promise: Promise.resolve() as Promise<T> };
    entry.promise = load().then(
      (value) => {
        entry.value = value;
        return value;
      },
      (error: unknown) => {
        // Неудачу кэшируем ненадолго, чтобы не долбить упавший источник.
        entry.expires = Date.now() + 10_000;
        if (current?.value !== undefined) {
          entry.value = current.value;
          return current.value;
        }
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      },
    );
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    return entry.promise;
  }

  /** Сократить срок жизни записи: например, если ответ собран не полностью. */
  shorten(key: string, ttlMs: number): void {
    const entry = this.entries.get(key);
    if (entry) entry.expires = Math.min(entry.expires, Date.now() + ttlMs);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}
