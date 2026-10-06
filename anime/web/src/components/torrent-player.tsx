// Серия из торрент-раздачи. Пока сервер качает начало серии и готовит HLS, показываем,
// как идёт подготовка (сколько раздающих, скорость), потом — наш обычный плеер.

import { lazy, Suspense, useEffect, useState } from 'react';
import type { Episode, TorrentPlayState } from '../../../shared/types.ts';
import { api } from '../api.ts';
import type { PlayerProps } from './player.tsx';

const Player = lazy(() => import('./player.tsx'));

export interface TorrentPlayerProps extends Omit<PlayerProps, 'episode'> {
  /** id плеера раздачи («torrent-<n>»). */
  player: string;
  dub: string | null;
  ordinal: number;
}

/** Сможет ли браузер показать видео в этом кодеке (HEVC умеют не все: iPhone и Mac — да). */
function canPlay(codec: string | null): boolean {
  const types: Record<string, string> = { hevc: 'video/mp4; codecs="hvc1.2.4.L153.B0"', av1: 'video/mp4; codecs="av01.0.08M.08"' };
  const type = codec ? types[codec] : undefined;
  if (!type) return true;
  return Boolean(window.MediaSource?.isTypeSupported?.(type)) || document.createElement('video').canPlayType(type) !== '';
}

function speedLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ/с`;
  return `${Math.round(bytes / 1024)} КБ/с`;
}

export default function TorrentPlayer(props: TorrentPlayerProps) {
  const { player, dub, ordinal } = props;
  const [state, setState] = useState<TorrentPlayState | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    setState(null);
    const ask = async () => {
      try {
        const next = await api<TorrentPlayState>('/api/torrent/play', { method: 'POST', body: JSON.stringify({ player, dub, ordinal }) });
        if (stopped) return;
        // Готовую серию не перерисовываем: этот же запрос раз в 20 секунд просто не даёт
        // серверу убрать её, пока плеер на паузе.
        setState((current) => (current?.status === 'ready' && next.status === 'ready' ? current : next));
        timer = window.setTimeout(ask, next.status === 'starting' ? 1500 : 20_000);
      } catch (error) {
        if (!stopped) setState({ status: 'error', message: (error as Error).message });
      }
    };
    void ask();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [player, dub, ordinal, attempt]);

  if (state?.status === 'ready' && !canPlay(state.codec)) {
    return (
      <div className="player placeholder notice-screen">
        <p>
          Эта раздача в {state.codec === 'hevc' ? 'HEVC (H.265)' : state.codec?.toUpperCase()}
          {state.height && state.height >= 2000 ? ', 4K' : ''}, а ваше устройство такое видео не показывает.
        </p>
        <p className="hint">Откройте на iPhone или Mac, в Chrome на компьютере с поддержкой HEVC — или выберите другой плеер.</p>
      </div>
    );
  }

  if (state?.status === 'ready') {
    const episode: Episode = {
      id: `${player}:${dub ?? ''}:${ordinal}:${state.playlist}`,
      ordinal,
      name: null,
      preview: null,
      duration: state.duration,
      opening: null,
      ending: null,
      sources: [{ quality: state.height ?? 1080, url: state.playlist }],
      master: null,
    };
    // Плейлист растёт, пока сервер готовит серию: для «досмотрено» берём полную длительность.
    const full = state.duration;
    return (
      <Suspense fallback={<div className="player placeholder" />}>
        <Player key={episode.id} {...props} episode={episode} onProgress={(time, duration, options) => props.onProgress(time, full ?? duration, options)} />
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
          <p>{state?.message ?? 'Подключаюсь к раздаче…'}</p>
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
