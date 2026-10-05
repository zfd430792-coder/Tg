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
CREATE TABLE IF NOT EXISTS release_state (
  release_id INTEGER PRIMARY KEY,
  fresh_at TEXT,
  last_ordinal REAL NOT NULL,
  checked_at TEXT NOT NULL
);
`;

const now = () => new Date().toISOString();

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
    const watched = input.watched || (input.duration > 0 && input.time / input.duration >= 0.92);
    const row = this.db
      .prepare(
        `INSERT INTO progress (user_id, release_id, episode_id, ordinal, time, duration, watched, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, episode_id) DO UPDATE SET time = excluded.time, duration = excluded.duration,
           ordinal = excluded.ordinal, watched = MAX(watched, excluded.watched), updated_at = excluded.updated_at
         RETURNING *`,
      )
      .get(userId, input.releaseId, input.episodeId, input.ordinal, input.time, input.duration, watched ? 1 : 0, now()) as Row;
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
