// Типы, которыми обмениваются сервер и фронтенд. Сервер приводит ответы
// AniLiberty к этим формам, чтобы фронтенд не зависел от формата чужого API.

export interface Genre {
  id: number;
  name: string;
}

export interface ReleaseCard {
  id: number;
  alias: string;
  title: string;
  titleEn: string | null;
  poster: string | null;
  type: string | null;
  year: number | null;
  season: string | null;
  ageRating: string | null;
  isOngoing: boolean;
  episodesTotal: number | null;
  publishDay: string | null;
  freshAt: string | null;
  genres: Genre[];
}

export interface TimeRange {
  start: number;
  stop: number;
}

export interface VideoSource {
  quality: number;
  url: string;
}

export interface Episode {
  id: string;
  ordinal: number;
  name: string | null;
  preview: string | null;
  duration: number | null;
  opening: TimeRange | null;
  ending: TimeRange | null;
  sources: VideoSource[];
  /** Мастер-плейлист со всеми качествами: по нему плеер переключает качество сам. */
  master: string | null;
}

export interface Release extends ReleaseCard {
  titleAlt: string | null;
  description: string | null;
  notification: string | null;
  averageDuration: number | null;
  favorites: number | null;
  blocked: boolean;
  voices: string[];
  episodes: Episode[];
}

/**
 * Озвучка (или субтитры) тайтла. AniLibria играет наш HLS-плеер, остальные —
 * встроенный плеер Kodik по ссылке из его API.
 */
export interface Dub {
  /** 'anilibria', 'kodik:<id перевода>' или 'kodik' — общий плеер Kodik с выбором внутри. */
  id: string;
  title: string;
  kind: 'hls' | 'iframe';
  type: 'voice' | 'subtitles' | null;
  /** Ссылка на плеер Kodik для этого перевода (только для iframe). */
  link: string | null;
  /** Последняя вышедшая серия в этой озвучке, если известна. */
  lastEpisode: number | null;
  /** Номер сезона у Kodik, если у тайтла их несколько. */
  season: number | null;
}

export interface ScheduleItem {
  release: ReleaseCard;
  lastEpisode: number | null;
  nextEpisode: number | null;
}

export interface ScheduleDay {
  day: number;
  title: string;
  items: ScheduleItem[];
}

export interface Option {
  value: string;
  label: string;
}

export interface References {
  genres: Genre[];
  types: Option[];
  sorting: Option[];
  years: number[];
}

export interface Page<T> {
  items: T[];
  page: number;
  totalPages: number;
  total: number;
}

export interface AppConfig {
  appName: string;
  botUsername: string | null;
  /** Короткое имя Mini App в BotFather: из него собираются ссылки t.me/<bot>/<app>. */
  appShortName: string | null;
  siteUrl: string | null;
  authEnabled: boolean;
}

export interface User {
  id: number;
  firstName: string;
  username: string | null;
  photoUrl: string | null;
  notify: boolean;
}

export interface EpisodeProgress {
  episodeId: string;
  ordinal: number;
  time: number;
  duration: number;
  watched: boolean;
  updatedAt: string;
}

export interface ReleaseUserState {
  favorite: boolean;
  subscribed: boolean;
  progress: EpisodeProgress[];
}

export interface HistoryItem extends EpisodeProgress {
  release: ReleaseCard;
}

export interface ProgressInput {
  releaseId: number;
  episodeId: string;
  ordinal: number;
  time: number;
  duration: number;
  watched?: boolean;
}
