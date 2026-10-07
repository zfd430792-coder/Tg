// Серия из торрент-раздачи. Пока сервер качает нужный кусок серии и готовит HLS, показываем,
// как идёт подготовка (сколько раздающих, скорость), потом — наш обычный плеер. Смена озвучки
// или качества и перемотка туда, где видео ещё нет, — новая подготовка с того же места.

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { Episode, TorrentPlayState } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { canPlayCodec } from '../torrents.ts';
import type { PlayerProps, TorrentTimeline } from './player.tsx';

const Player = lazy(() => import('./player.tsx'));

export interface TorrentPlayerProps extends Omit<PlayerProps, 'episode' | 'torrent'> {
  /** Вариант: раздача и дорожка в ней («<раздача>:e<дорожка>» или «:x<папка озвучки>»). */
  variant: string;
  /** Браузер не покажет кодек этой раздачи (HEVC) — сервер перекодирует видео в H.264. */
  convert: boolean;
  ordinal: number;
  /** Качества этой озвучки (каждое — своя раздача) и выбранное. */
  qualities: number[];
  quality: number | null;
  onQuality: (height: number) => void;
}

/** Сервер готовит серию с круглой секунды: так одну и ту же подготовку делят разные зрители. */
const startOf = (time: number) => (time < 15 ? 0 : Math.floor(time / 10) * 10);

function speedLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ/с`;
  return `${Math.round(bytes / 1024)} КБ/с`;
}

interface Request {
  variant: string;
  convert: boolean;
  /** С какой секунды серии сервер готовит видео. */
  start: number;
  /** С какой секунды включить. */
  at: number;
}

export default function TorrentPlayer(props: TorrentPlayerProps) {
  const { variant, convert, ordinal } = props;
  const [request, setRequest] = useState<Request>(() => ({ variant, convert, start: startOf(props.startAt), at: props.startAt }));
  const [state, setState] = useState<TorrentPlayState | null>(null);
  const [attempt, setAttempt] = useState(0);
  /** Где смотрят сейчас (секунда серии) и какую подготовку смотрят — её сервер может отпустить. */
  const position = useRef(props.startAt);
  const session = useRef<string | null>(null);

  // Озвучку или качество сменили — тот же момент серии, но из другой раздачи или с другой дорожкой.
  useEffect(() => {
    if (variant === request.variant && convert === request.convert) return;
    setRequest({ variant, convert, start: startOf(position.current), at: position.current });
  }, [variant, convert, request.variant, request.convert]);

  useEffect(() => {
    let stopped = false;
    let ready = false;
    let timer: number | undefined;
    setState(null);
    const ask = async () => {
      try {
        const body = { variant: request.variant, ordinal, start: request.start, previous: session.current, transcode: request.convert };
        const next = await api<TorrentPlayState>('/api/torrent/play', { method: 'POST', body: JSON.stringify(body) });
        if (stopped) return;
        if (next.status === 'ready') session.current = next.session;
        // Готовую серию не трогаем: этот же запрос раз в 20 секунд просто не даёт серверу убрать
        // её, пока плеер на паузе. Даже если раздачу тем временем заменили, видео уже готовится.
        if (!ready) setState(next);
        ready ||= next.status === 'ready';
        if (ready || next.status !== 'error') timer = window.setTimeout(ask, next.status === 'starting' ? 1500 : next.status === 'busy' ? 10_000 : 20_000);
      } catch (error) {
        if (stopped) return;
        if (ready) timer = window.setTimeout(ask, 20_000);
        else setState({ status: 'error', message: (error as Error).message });
      }
    };
    void ask();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [request, ordinal, attempt]);

  // Перемотали туда, где видео ещё нет (или назад, до начала подготовленного куска).
  const seekOutside = useCallback((time: number) => {
    position.current = time;
    setRequest((current) => ({ ...current, start: startOf(time), at: time }));
  }, []);

  if (state?.status === 'ready' && !canPlayCodec(state.codec)) {
    return (
      <div className="player placeholder notice-screen">
        <p>
          Эта раздача в {state.codec === 'hevc' ? 'HEVC (H.265)' : state.codec?.toUpperCase()}
          {state.height && state.height >= 2000 ? ', 4K' : ''}, а ваше устройство такое видео не показывает.
        </p>
        <p className="hint">Выберите другое качество — или откройте на iPhone, Mac или в Chrome на компьютере с поддержкой HEVC.</p>
      </div>
    );
  }

  if (state?.status === 'ready') {
    const episode: Episode = {
      id: `${request.variant}:${ordinal}:${state.session}:${request.at}`,
      ordinal,
      name: null,
      preview: null,
      duration: state.duration,
      opening: null,
      ending: null,
      sources: [{ quality: state.height ?? 1080, url: state.playlist }],
      master: null,
    };
    const timeline: TorrentTimeline = {
      offset: state.offset,
      duration: state.duration,
      onSeekOutside: seekOutside,
      onTime: (time) => (position.current = time),
      qualities: props.qualities,
      quality: props.quality,
      onQuality: props.onQuality,
    };
    return (
      <Suspense fallback={<div className="player placeholder" />}>
        <Player
          key={episode.id}
          {...props}
          episode={episode}
          startAt={request.at}
          torrent={timeline}
          onProgress={(time, duration, options) => {
            position.current = time;
            props.onProgress(time, duration, options);
          }}
        />
      </Suspense>
    );
  }

  return (
    <div className="player placeholder notice-screen">
      {state?.status === 'error' || state?.status === 'busy' ? (
        <>
          <p>{state.message}</p>
          <button className="btn" onClick={() => setAttempt((n) => n + 1)}>
            Попробовать ещё раз
          </button>
        </>
      ) : (
        <>
          <span className="spinner" />
          <p>{state?.message ?? (request.at > 0 ? 'Готовлю серию с того же места…' : 'Подключаюсь к раздаче…')}</p>
          {state?.status === 'starting' && (
            <p className="hint">
              Раздающих: {state.peers} · {speedLabel(state.speed)}
            </p>
          )}
        </>
      )}
    </div>
  );
}
