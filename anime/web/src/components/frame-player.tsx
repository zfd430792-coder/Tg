// Встроенный плеер видеобалансера (Kodik и другие) в iframe. Kodik сообщает
// о себе через postMessage: {key: 'kodik_player_time_update', value: секунды} и т.п. —
// по этим событиям сохраняем прогресс и узнаём, какую серию выбрали внутри плеера.

import { useEffect, useRef } from 'react';

export interface FramePlayerProps {
  src: string;
  title: string;
  /** Какая серия открыта по src. Дальше плеер сам сообщает, если её сменили внутри. */
  episode: number;
  /** Прогресс приходит с номером серии: к моменту сохранения страница может уже показывать другую. */
  onProgress: (episode: number, time: number, duration: number, options: { watched: boolean; leaving: boolean }) => void;
  /** Плеер сам переключил серию (через свой список серий или автопереход). */
  onEpisode?: (episode: number) => void;
  onEnded?: () => void;
}

interface FrameMessage {
  key?: unknown;
  value?: unknown;
}

export default function FramePlayer(props: FramePlayerProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const state = useRef({ episode: props.episode, time: 0, duration: 0, reported: 0, ended: false });

  useEffect(() => {
    state.current = { episode: latest.current.episode, time: 0, duration: 0, reported: 0, ended: false };
    const report = (leaving: boolean, watched = false) => {
      const { episode, time, duration } = state.current;
      if (time < 1 || duration <= 0) return;
      state.current.reported = time;
      latest.current.onProgress(episode, time, duration, { watched: watched || state.current.ended, leaving });
    };

    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const data = event.data as FrameMessage;
      if (!data || typeof data !== 'object' || typeof data.key !== 'string') return;
      const value = data.value as any;
      switch (data.key) {
        case 'kodik_player_duration_update':
          if (Number(value) > 0) state.current.duration = Number(value);
          break;
        case 'kodik_player_time_update': {
          const time = Number(value);
          if (!Number.isFinite(time)) break;
          state.current.time = time;
          if (Math.abs(time - state.current.reported) >= 10) report(false);
          break;
        }
        case 'kodik_player_pause':
          report(false);
          break;
        case 'kodik_player_video_ended':
          state.current.ended = true;
          if (state.current.duration > 0) state.current.time = state.current.duration;
          report(false, true);
          latest.current.onEnded?.();
          break;
        case 'kodik_player_current_episode': {
          const episode = Number(value?.episode);
          if (Number.isFinite(episode) && episode > 0 && episode !== state.current.episode) {
            // Серию сменили внутри плеера: прошлую досохраняем, счётчики начинаем заново.
            report(false);
            state.current = { episode, time: 0, duration: 0, reported: 0, ended: false };
            latest.current.onEpisode?.(episode);
          }
          break;
        }
      }
    };
    const onHide = () => document.visibilityState === 'hidden' && report(true);

    window.addEventListener('message', onMessage);
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      report(false);
      window.removeEventListener('message', onMessage);
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [props.src]);

  return (
    <div className="player frame">
      <iframe
        ref={frame}
        src={props.src}
        title={props.title}
        allow="autoplay *; fullscreen *; picture-in-picture *; encrypted-media *"
        allowFullScreen
        referrerPolicy="origin"
      />
    </div>
  );
}
