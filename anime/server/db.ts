// Хранилище пользователей: избранное, подписки на новые серии, прогресс
// просмотра. SQLite встроен в Node, так что отдельная база не нужна.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EpisodeProgress, HistoryItem, ProgressInput, ReleaseCard, User } from '../shared/types.ts';
import type { TelegramUser } from './auth.ts';

type Row = Record<string, any>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL,
  username TEXT,
  photo_url TEXT,
  language TEXT,
  notify INTEGER NOT NULL DEFAULT 1,
  blocked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY,
  card TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  release_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, release_id)
);
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  release_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, release_id)
);
CREATE INDEX IF NOT EXISTS subscriptions_release ON subscriptions(release_id);
CREATE TABLE IF NOT EXISTS progress (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  release_id INTEGER NOT NULL,
  episode_id TEXT NOT NULL,
  ordinal REAL NOT NULL,
  time REAL NOT NULL,
  duration REAL NOT NULL,
  watched INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, episode_id)
);
CREATE INDEX IF NOT EXISTS progress_user_release ON progress(user_id, release_id, updated_at);
CREATE TABLE IF NOT EXISTS release_ids (
  release_id INTEGER PRIMARY KEY,
  shikimori_id TEXT,
  kinopoisk_id TEXT,
  kp_season INTEGER,
  imdb_id TEXT,
  checked_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS torrents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id INTEGER NOT NULL,
  magnet TEXT NOT NULL,
  info_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  info TEXT,
  error TEXT,
  added_at TEXT NOT NULL,
  UNIQUE (release_id, info_hash)
);
-- Когда для тайтла последний раз искали раздачи и что нашли.
CREATE TABLE IF NOT EXISTS torrent_searches (
  release_id INTEGER PRIMARY KEY,
  searched_at TEXT NOT NULL,
  found INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE TABLE IF NOT EXISTS release_state (
  release_id INTEGER PRIMARY KEY,
  fresh_at TEXT,
  last_ordinal REAL NOT NULL,
  checked_at TEXT NOT NULL
);
`;

const now = () => new Date().toISOString();

export interface TorrentRow {
  id: number;
  releaseId: number;
  magnet: string;
  infoHash: string;
  status: 'pending' | 'ready' | 'error';
  info: unknown;
  error: string | null;
  addedAt: string;
  /** manual — добавлена командой animini torrent add, остальные сервер нашёл сам. */
  source: 'manual' | 'anilibria' | 'jacred';
  title: string | null;
  seeders: number | null;
  size: number | null;
  /** Как разбирать раздачу: сезон тайтла, сборник ли это сезонов, сколько серий в тайтле и последний ли это сезон сборника. */
  hint: { season: number; pack: boolean; episodes?: number | null; lastSeason?: boolean } | null;
}

/** Раздача, которую нашёл поиск (см. torrents/search.ts). */
export interface FoundTorrentInput {
  source: 'anilibria' | 'jacred';
  magnet: string;
  infoHash: string;
  title: string;
  seeders: number;
  size: number | null;
  season: number;
  pack: boolean;
  episodes?: number | null;
  lastSeason?: boolean;
}

function json<T>(value: unknown): T | null {
  try {
    return typeof value === 'string' && value ? (JSON.parse(value) as T) : null;
  } catch {
    return null;
  }
}

function toTorrent(row: Row): TorrentRow {
  return {
    id: row.id,
    releaseId: row.release_id,
    magnet: row.magnet,
    infoHash: row.info_hash,
    status: row.status,
    info: json(row.info),
    error: row.error ?? null,
    addedAt: row.added_at,
    source: row.source ?? 'manual',
    title: row.title ?? null,
    seeders: row.seeders ?? null,
    size: row.size ?? null,
    hint: json(row.hint),
  };
}

function toUser(row: Row): User {
  return {
    id: row.id,
    firstName: row.first_name,
    username: row.username ?? null,
    photoUrl: row.photo_url ?? null,
    notify: Boolean(row.notify),
  };
}

function toProgress(row: Row): EpisodeProgress {
  return {
    episodeId: row.episode_id,
    ordinal: row.ordinal,
    time: row.time,
    duration: row.duration,
    watched: Boolean(row.watched),
    updatedAt: row.updated_at,
  };
}

export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Новые столбцы в таблицах, созданных старой версией. */
  private migrate(): void {
    const columns = new Set((this.db.prepare('PRAGMA table_info(torrents)').all() as Row[]).map((c) => c.name));
    const add: [string, string][] = [
      ['source', "TEXT NOT NULL DEFAULT 'manual'"],
      ['title', 'TEXT'],
      ['seeders', 'INTEGER'],
      ['size', 'INTEGER'],
      ['hint', 'TEXT'],
    ];
    for (const [name, type] of add) if (!columns.has(name)) this.db.exec(`ALTER TABLE torrents ADD COLUMN ${name} ${type}`);
  }

  close(): void {
    this.db.close();
  }

  upsertUser(user: TelegramUser): User {
    const at = now();
    const row = this.db
      .prepare(
        `INSERT INTO users (id, first_name, username, photo_url, language, created_at, seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET first_name = excluded.first_name, username = excluded.username,
           photo_url = excluded.photo_url, language = excluded.language, seen_at = excluded.seen_at, blocked = 0
         RETURNING *`,
      )
      .get(user.id, user.first_name || 'Без имени', user.username ?? null, user.photo_url ?? null, user.language_code ?? null, at, at) as Row;
    return toUser(row);
  }

  getUser(id: number): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    return row ? toUser(row) : null;
  }

  setNotify(id: number, notify: boolean): void {
    this.db.prepare('UPDATE users SET notify = ? WHERE id = ?').run(notify ? 1 : 0, id);
  }

  /** Пользователь заблокировал бота: писать ему бесполезно, пока он не вернётся. */
  markBlocked(id: number): void {
    this.db.prepare('UPDATE users SET blocked = 1 WHERE id = ?').run(id);
  }

  saveCard(card: ReleaseCard): void {
    this.db
      .prepare(
        `INSERT INTO releases (id, card, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET card = excluded.card, updated_at = excluded.updated_at`,
      )
      .run(card.id, JSON.stringify(card), now());
  }

  getCard(id: number): ReleaseCard | null {
    const row = this.db.prepare('SELECT card FROM releases WHERE id = ?').get(id) as Row | undefined;
    return row ? JSON.parse(row.card) : null;
  }

  setFavorite(userId: number, releaseId: number, on: boolean): void {
    if (on) {
      this.db.prepare('INSERT OR IGNORE INTO favorites (user_id, release_id, created_at) VALUES (?, ?, ?)').run(userId, releaseId, now());
    } else {
      this.db.prepare('DELETE FROM favorites WHERE user_id = ? AND release_id = ?').run(userId, releaseId);
    }
  }

  favorites(userId: number): ReleaseCard[] {
    return this.cards(
      `SELECT r.card FROM favorites f JOIN releases r ON r.id = f.release_id
       WHERE f.user_id = ? ORDER BY f.created_at DESC`,
      userId,
    );
  }

  setSubscribed(userId: number, releaseId: number, on: boolean): void {
    if (on) {
      this.db.prepare('INSERT OR IGNORE INTO subscriptions (user_id, release_id, created_at) VALUES (?, ?, ?)').run(userId, releaseId, now());
    } else {
      this.db.prepare('DELETE FROM subscriptions WHERE user_id = ? AND release_id = ?').run(userId, releaseId);
    }
  }

  subscriptions(userId: number): ReleaseCard[] {
    return this.cards(
      `SELECT r.card FROM subscriptions s JOIN releases r ON r.id = s.release_id
       WHERE s.user_id = ? ORDER BY s.created_at DESC`,
      userId,
    );
  }

  subscribedReleaseIds(): Set<number> {
    const rows = this.db.prepare('SELECT DISTINCT release_id FROM subscriptions').all() as Row[];
    return new Set(rows.map((r) => r.release_id));
  }

  /** Кому слать уведомление о новой серии: подписаны, не выключили уведомления, не заблокировали бота. */
  subscribers(releaseId: number): number[] {
    const rows = this.db
      .prepare(
        `SELECT u.id FROM subscriptions s JOIN users u ON u.id = s.user_id
         WHERE s.release_id = ? AND u.notify = 1 AND u.blocked = 0`,
      )
      .all(releaseId) as Row[];
    return rows.map((r) => r.id);
  }

  releaseFlags(userId: number, releaseId: number): { favorite: boolean; subscribed: boolean } {
    const favorite = this.db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND release_id = ?').get(userId, releaseId);
    const subscribed = this.db.prepare('SELECT 1 FROM subscriptions WHERE user_id = ? AND release_id = ?').get(userId, releaseId);
    return { favorite: Boolean(favorite), subscribed: Boolean(subscribed) };
  }

  saveProgress(userId: number, input: ProgressInput): EpisodeProgress {
    let watched = input.watched || (input.duration > 0 && input.time / input.duration >= 0.92);
    // Та же серия могла быть записана под другим ID: серия «только из Kodik», которая потом
    // вышла у AniLibria, или старый общий для всех тайтлов ID n<номер>. Оставляем одну
    // запись, отметку «просмотрено» переносим.
    const others = this.db
      .prepare('DELETE FROM progress WHERE user_id = ? AND release_id = ? AND ordinal = ? AND episode_id <> ? RETURNING watched, time, duration')
      .all(userId, input.releaseId, input.ordinal, input.episodeId) as Row[];
    if (others.some((r) => r.watched)) watched = true;
    // duration = 0 — только отметка «серия открыта» (плеер не сообщает время): сохранённую
    // позицию она не затирает, а лишь поднимает тайтл в «Продолжить просмотр».
    const kept = input.duration === 0 ? others.find((r) => r.duration > 0) : undefined;
    const time = kept ? kept.time : input.time;
    const duration = kept ? kept.duration : input.duration;
    const row = this.db
      .prepare(
        `INSERT INTO progress (user_id, release_id, episode_id, ordinal, time, duration, watched, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, episode_id) DO UPDATE SET
           time = CASE WHEN excluded.duration > 0 THEN excluded.time ELSE time END,
           duration = CASE WHEN excluded.duration > 0 THEN excluded.duration ELSE duration END,
           ordinal = excluded.ordinal, watched = MAX(watched, excluded.watched), updated_at = excluded.updated_at
         RETURNING *`,
      )
      .get(userId, input.releaseId, input.episodeId, input.ordinal, time, duration, watched ? 1 : 0, now()) as Row;
    return toProgress(row);
  }

  progress(userId: number, releaseId: number): EpisodeProgress[] {
    const rows = this.db
      .prepare('SELECT * FROM progress WHERE user_id = ? AND release_id = ? ORDER BY ordinal')
      .all(userId, releaseId) as Row[];
    return rows.map(toProgress);
  }

  /** «Продолжить просмотр»: по одной, последней по времени серии на каждый тайтл. */
  history(userId: number, limit = 30): HistoryItem[] {
    const rows = this.db
      .prepare(
        `SELECT p.*, r.card FROM progress p JOIN releases r ON r.id = p.release_id
         WHERE p.user_id = ? AND p.rowid = (
           SELECT rowid FROM progress WHERE user_id = p.user_id AND release_id = p.release_id
           ORDER BY updated_at DESC LIMIT 1)
         ORDER BY p.updated_at DESC LIMIT ?`,
      )
      .all(userId, limit) as Row[];
    return rows.map((row) => ({ ...toProgress(row), release: JSON.parse(row.card) }));
  }

  /** ID тайтла на Кинопоиске/IMDb/Shikimori, найденные для Alloha. */
  releaseIds(releaseId: number): { shikimori: string | null; kinopoisk: string | null; kpSeason: number | null; imdb: string | null; checkedAt: string } | null {
    const row = this.db.prepare('SELECT * FROM release_ids WHERE release_id = ?').get(releaseId) as Row | undefined;
    if (!row) return null;
    return { shikimori: row.shikimori_id, kinopoisk: row.kinopoisk_id, kpSeason: row.kp_season, imdb: row.imdb_id, checkedAt: row.checked_at };
  }

  saveReleaseIds(releaseId: number, ids: { shikimori: string | null; kinopoisk: string | null; kpSeason: number | null; imdb: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO release_ids (release_id, shikimori_id, kinopoisk_id, kp_season, imdb_id, checked_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(release_id) DO UPDATE SET shikimori_id = excluded.shikimori_id, kinopoisk_id = excluded.kinopoisk_id,
           kp_season = excluded.kp_season, imdb_id = excluded.imdb_id, checked_at = excluded.checked_at`,
      )
      .run(releaseId, ids.shikimori, ids.kinopoisk, ids.kpSeason, ids.imdb, now());
  }

  /** Раздача, добавленная руками (animini torrent add): разбирается заново, даже если уже была. */
  addTorrent(releaseId: number, magnet: string, infoHash: string): TorrentRow {
    const row = this.db
      .prepare(
        `INSERT INTO torrents (release_id, magnet, info_hash, status, added_at, source) VALUES (?, ?, ?, 'pending', ?, 'manual')
         ON CONFLICT(release_id, info_hash) DO UPDATE SET magnet = excluded.magnet, status = 'pending', error = NULL, source = 'manual'
         RETURNING *`,
      )
      .get(releaseId, magnet, infoHash, now()) as Row;
    return toTorrent(row);
  }

  /**
   * Результат поиска раздач для тайтла: новые — в очередь на разбор, уже разобранные — как
   * есть (обновляем число раздающих), те, что раньше не открылись, — попробовать снова. Найденные
   * раньше, но пропавшие из поиска (обновили на трекере, умерли) — удаляем, если их источник
   * ответил; добавленные руками — никогда.
   */
  replaceFoundTorrents(releaseId: number, found: FoundTorrentInput[], failed: FoundTorrentInput['source'][] = [], keep: Set<string> = new Set()): void {
    this.db.exec('BEGIN');
    try {
      const upsert = this.db.prepare(
        `INSERT INTO torrents (release_id, magnet, info_hash, status, added_at, source, title, seeders, size, hint)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(release_id, info_hash) DO UPDATE SET
           title = excluded.title, seeders = excluded.seeders, size = excluded.size, hint = excluded.hint,
           source = CASE WHEN torrents.source = 'manual' THEN 'manual' ELSE excluded.source END,
           status = CASE WHEN torrents.status = 'error' THEN 'pending' ELSE torrents.status END,
           error = CASE WHEN torrents.status = 'error' THEN NULL ELSE torrents.error END`,
      );
      for (const t of found) {
        const hint = { season: t.season, pack: t.pack, episodes: t.episodes ?? null, lastSeason: t.lastSeason ?? true };
        upsert.run(releaseId, t.magnet, t.infoHash, now(), t.source, t.title, t.seeders, t.size, JSON.stringify(hint));
      }
      const wanted = new Set(found.map((t) => t.infoHash));
      const rows = this.db.prepare(`SELECT id, info_hash, source FROM torrents WHERE release_id = ? AND source != 'manual'`).all(releaseId) as Row[];
      const remove = this.db.prepare('DELETE FROM torrents WHERE id = ?');
      // Источник не ответил — его прежние раздачи оставляем до следующего поиска.
      for (const row of rows) if (!wanted.has(row.info_hash) && !keep.has(row.info_hash) && !failed.includes(row.source)) remove.run(row.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  torrentSearch(releaseId: number): { searchedAt: string; found: number; error: string | null } | null {
    const row = this.db.prepare('SELECT * FROM torrent_searches WHERE release_id = ?').get(releaseId) as Row | undefined;
    return row ? { searchedAt: row.searched_at, found: row.found, error: row.error ?? null } : null;
  }

  saveTorrentSearch(releaseId: number, found: number, error: string | null): void {
    this.db
      .prepare(
        `INSERT INTO torrent_searches (release_id, searched_at, found, error) VALUES (?, ?, ?, ?)
         ON CONFLICT(release_id) DO UPDATE SET searched_at = excluded.searched_at, found = excluded.found, error = excluded.error`,
      )
      .run(releaseId, now(), found, error?.slice(0, 500) ?? null);
  }

  torrents(filter: { releaseId?: number; status?: TorrentRow['status'] } = {}): TorrentRow[] {
    const rows = this.db
      .prepare('SELECT * FROM torrents WHERE (? IS NULL OR release_id = ?) AND (? IS NULL OR status = ?) ORDER BY id')
      .all(filter.releaseId ?? null, filter.releaseId ?? null, filter.status ?? null, filter.status ?? null) as Row[];
    return rows.map(toTorrent);
  }

  torrent(id: number): TorrentRow | null {
    const row = this.db.prepare('SELECT * FROM torrents WHERE id = ?').get(id) as Row | undefined;
    return row ? toTorrent(row) : null;
  }

  setTorrentReady(id: number, info: unknown): void {
    this.db.prepare(`UPDATE torrents SET status = 'ready', info = ?, error = NULL WHERE id = ?`).run(JSON.stringify(info), id);
  }

  setTorrentError(id: number, error: string): void {
    this.db.prepare(`UPDATE torrents SET status = 'error', error = ? WHERE id = ?`).run(error.slice(0, 500), id);
  }

  removeTorrent(id: number): boolean {
    return this.db.prepare('DELETE FROM torrents WHERE id = ?').run(id).changes > 0;
  }

  releaseState(releaseId: number): { freshAt: string | null; lastOrdinal: number } | null {
    const row = this.db.prepare('SELECT * FROM release_state WHERE release_id = ?').get(releaseId) as Row | undefined;
    return row ? { freshAt: row.fresh_at ?? null, lastOrdinal: row.last_ordinal } : null;
  }

  setReleaseState(releaseId: number, freshAt: string | null, lastOrdinal: number): void {
    this.db
      .prepare(
        `INSERT INTO release_state (release_id, fresh_at, last_ordinal, checked_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(release_id) DO UPDATE SET fresh_at = excluded.fresh_at, last_ordinal = excluded.last_ordinal,
           checked_at = excluded.checked_at`,
      )
      .run(releaseId, freshAt, lastOrdinal, now());
  }

  private cards(sql: string, ...params: (number | string)[]): ReleaseCard[] {
    return (this.db.prepare(sql).all(...params) as Row[]).map((row) => JSON.parse(row.card));
  }
}
