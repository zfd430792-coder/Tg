// Свой HLS-плеер. Видео режется на сегменты по несколько секунд (.ts/.m4s),
// плейлист .m3u8 перечисляет их, а hls.js скармливает сегменты браузеру через
// Media Source Extensions. В Safari и на iPhone HLS работает нативно.
//
// Качество: сервер собирает мастер-плейлист из 480/720/1080, поэтому в режиме
// «Авто» hls.js сам выбирает качество по скорости сети, а пользователь может
// зафиксировать нужное.

import Hls from 'hls.js/light';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Episode } from '../../../shared/types.ts';
import { clock } from '../format.ts';
import { appFullscreen, haptic, tg } from '../telegram.ts';
import { getSettings, updateSettings, useSettings } from '../user.ts';
import { Icon } from './icons.tsx';
import { Sheet } from './ui.tsx';

export interface PlayerProps {
  episode: Episode;
  title: string;
  subtitle: string;
  poster: string | null;
  startAt: number;
  hasNext: boolean;
  hasPrev: boolean;
  onNext: () => void;
  onPrev: () => void;
  onProgress: (time: number, duration: number, options: { watched: boolean; leaving: boolean }) => void;
}

type Menu = null | 'main' | 'quality' | 'speed';
type FullscreenMode = 'none' | 'native' | 'fake';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function preferNativeHls(): boolean {
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const safari = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(ua);
  return (iOS || safari) && Boolean(document.createElement('video').canPlayType('application/vnd.apple.mpegurl'));
}

function closestLevel(heights: number[], wanted: number): number {
  let best = -1;
  heights.forEach((h, i) => {
    if (best === -1 || Math.abs(h - wanted) < Math.abs(heights[best] - wanted)) best = i;
  });
  return best;
}

export default function Player(props: PlayerProps) {
  const { episode } = props;
  const settings = useSettings();
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const hls = useRef<Hls | null>(null);
  const latest = useRef(props);
  latest.current = props;

  const native = useMemo(preferNativeHls, []);
  const coarse = useMemo(() => matchMedia('(pointer: coarse)').matches, []);

  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(props.startAt);
  const [duration, setDuration] = useState(episode.duration ?? 0);
  const [buffered, setBuffered] = useState(0);
  const [waiting, setWaiting] = useState(true);
  const [needsTap, setNeedsTap] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>([]);
  const [activeHeight, setActiveHeight] = useState<number | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [rate, setRate] = useState(1);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [fullscreen, setFullscreen] = useState<FullscreenMode>('none');
  const [controls, setControls] = useState(true);
  const [preview, setPreview] = useState<number | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);

  const resumeAt = useRef(props.startAt);
  const lastReport = useRef(0);
  const autoSkipped = useRef(false);
  const hideTimer = useRef<number | undefined>(undefined);
  const flashTimer = useRef<number | undefined>(undefined);
  const commitTimer = useRef<number | undefined>(undefined);
  const tapTimer = useRef<number | undefined>(undefined);
  const lastTap = useRef(0);
  const menuOpen = useRef(false);
  menuOpen.current = menu !== null;

  const nativeQuality = native ? settings.quality : null;

  // ---- Прогресс ----

  // Элемент можно передать явно: при размонтировании React уже обнулил ref.
  const report = useCallback((leaving: boolean, ended = false, target?: HTMLVideoElement) => {
    const el = target ?? video.current;
    if (!el || !el.duration || el.currentTime < 1) return;
    const ending = latest.current.episode.ending;
    const watched = ended || Boolean(ending && el.currentTime >= ending.start);
    lastReport.current = el.currentTime;
    latest.current.onProgress(el.currentTime, el.duration, { watched, leaving });
  }, []);

  // ---- Источник видео ----

  const tryPlay = useCallback(() => {
    const el = video.current;
    if (!el) return;
    el.play().catch((err: DOMException) => {
      if (err.name === 'NotAllowedError') setNeedsTap(true);
    });
  }, []);

  useEffect(() => {
    const el = video.current!;
    const { episode } = latest.current;
    setError(null);
    setWaiting(true);
    const start = resumeAt.current;
    const best = episode.sources[episode.sources.length - 1]?.url;
    if (!best) {
      setError('Видео для этой серии пока нет');
      return;
    }

    let instance: Hls | null = null;
    if (!native && Hls.isSupported()) {
      instance = new Hls({ startPosition: start > 0 ? start : -1, maxBufferLength: 30, maxMaxBufferLength: 120 });
      hls.current = instance;
      let networkRetries = 0;
      let mediaRecovered = false;
      instance.on(Hls.Events.MANIFEST_PARSED, () => {
        const heights = instance!.levels.map((level) => level.height);
        setLevels(heights);
        const wanted = getSettings().quality;
        if (wanted !== 'auto' && heights.length > 1) instance!.currentLevel = closestLevel(heights, wanted);
        tryPlay();
      });
      instance.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        setActiveHeight(instance!.levels[data.level]?.height ?? null);
      });
      instance.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries < 3) {
          networkRetries += 1;
          window.setTimeout(() => instance!.startLoad(), 1000 * networkRetries);
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecovered) {
          mediaRecovered = true;
          instance!.recoverMediaError();
          return;
        }
        setError('Не удалось загрузить видео');
      });
      instance.loadSource(episode.master ?? best);
      instance.attachMedia(el);
    } else if (el.canPlayType('application/vnd.apple.mpegurl')) {
      const wanted = getSettings().quality;
      const fixed = wanted === 'auto' ? undefined : episode.sources.find((s) => s.quality === wanted);
      setLevels(episode.sources.map((s) => s.quality));
      setActiveHeight(fixed?.quality ?? null);
      el.src = fixed?.url ?? episode.master ?? best;
      el.addEventListener(
        'loadedmetadata',
        () => {
          if (start > 0) el.currentTime = start;
          tryPlay();
        },
        { once: true },
      );
    } else {
      setError('Этот браузер не умеет показывать HLS-видео');
    }

    return () => {
      // Сначала сохраняем прогресс: после сброса источника currentTime станет 0.
      report(false, false, el);
      instance?.destroy();
      hls.current = null;
      el.removeAttribute('src');
      el.load();
    };
    // Пересоздаём источник только при смене серии, качества (нативный HLS) или повторе.
  }, [episode.id, native, nativeQuality, attempt, tryPlay, report]);

  useEffect(() => {
    const el = video.current!;
    const onTime = () => {
      setTime(el.currentTime);
      if (!el.paused && Math.abs(el.currentTime - lastReport.current) >= 10) report(false);
    };
    const onProgress = () => {
      const t = el.currentTime;
      for (let i = 0; i < el.buffered.length; i++) {
        if (el.buffered.start(i) <= t + 0.5 && el.buffered.end(i) >= t) {
          setBuffered(el.buffered.end(i));
          return;
        }
      }
    };
    const onPlay = () => {
      setPlaying(true);
      setNeedsTap(false);
      setCountdown(null);
    };
    const onPause = () => {
      setPlaying(false);
      report(false);
    };
    const onEnded = () => {
      setPlaying(false);
      report(false, true);
      if (latest.current.hasNext && getSettings().autoNext) setCountdown(5);
    };
    const onDuration = () => Number.isFinite(el.duration) && setDuration(el.duration);
    const onWaiting = () => setWaiting(true);
    const onReady = () => setWaiting(false);
    const onVolume = () => {
      setMuted(el.muted);
      setVolume(el.volume);
    };
    const onRate = () => setRate(el.playbackRate);
    const onError = () => {
      if (!hls.current) setError('Не удалось загрузить видео');
    };
    const events: [string, () => void][] = [
      ['timeupdate', onTime],
      ['progress', onProgress],
      ['play', onPlay],
      ['pause', onPause],
      ['ended', onEnded],
      ['durationchange', onDuration],
      ['waiting', onWaiting],
      ['seeking', onWaiting],
      ['playing', onReady],
      ['canplay', onReady],
      ['seeked', onReady],
      ['volumechange', onVolume],
      ['ratechange', onRate],
      ['error', onError],
    ];
    events.forEach(([name, fn]) => el.addEventListener(name, fn));
    const onHide = () => document.visibilityState === 'hidden' && report(true);
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      events.forEach(([name, fn]) => el.removeEventListener(name, fn));
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [report]);

  // Скорость сохраняем между сериями.
  useEffect(() => {
    if (video.current) video.current.playbackRate = rate;
  }, [episode.id, rate]);

  // ---- Управление ----

  const showFlash = useCallback((text: string) => {
    setFlash(text);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 900);
  }, []);

  const poke = useCallback(() => {
    setControls(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (video.current && !video.current.paused && !menuOpen.current) setControls(false);
    }, 3000);
  }, []);

  const togglePlay = useCallback(() => {
    const el = video.current;
    if (!el) return;
    if (el.paused) {
      if (el.ended) el.currentTime = 0;
      tryPlay();
    } else {
      el.pause();
    }
  }, [tryPlay]);

  const seekTo = useCallback((value: number) => {
    const el = video.current;
    if (!el) return;
    const max = Number.isFinite(el.duration) ? el.duration : value;
    el.currentTime = Math.max(0, Math.min(value, max - 0.2));
    setTime(el.currentTime);
  }, []);

  const seekBy = useCallback(
    (delta: number) => {
      if (!video.current) return;
      seekTo(video.current.currentTime + delta);
      showFlash(delta > 0 ? `+${delta} с` : `−${-delta} с`);
      haptic('light');
    },
    [seekTo, showFlash],
  );

  const setQuality = (value: 'auto' | number) => {
    updateSettings({ quality: value });
    setMenu(null);
    haptic('select');
    const instance = hls.current;
    if (instance) {
      instance.currentLevel = value === 'auto' ? -1 : closestLevel(instance.levels.map((l) => l.height), value);
    } else if (video.current) {
      // Нативный HLS: меняем ссылку и продолжаем с того же места.
      resumeAt.current = video.current.currentTime;
    }
  };

  const setSpeed = (value: number) => {
    if (video.current) video.current.playbackRate = value;
    setRate(value);
    setMenu(null);
    haptic('select');
  };

  const toggleMute = () => {
    const el = video.current;
    if (!el) return;
    el.muted = !el.muted;
    if (!el.muted && el.volume === 0) el.volume = 0.5;
  };

  // ---- Полный экран ----
  // Обычный браузер: Fullscreen API. iPhone: нативный плеер iOS.
  // Где ничего нет (часть WebView в Telegram) — растягиваем плеер на всё окно сами.

  const enterFullscreen = async () => {
    const el = box.current!;
    const v = video.current as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
    if (document.fullscreenEnabled && el.requestFullscreen) {
      try {
        await el.requestFullscreen({ navigationUI: 'hide' });
        setFullscreen('native');
        (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape').catch(() => undefined);
        return;
      } catch {
        // упадём на запасной вариант
      }
    }
    if (v?.webkitEnterFullscreen && !tg) {
      v.webkitEnterFullscreen();
      return;
    }
    setFullscreen('fake');
    appFullscreen(true);
  };

  const exitFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    setFullscreen((mode) => {
      if (mode === 'fake') appFullscreen(false);
      return 'none';
    });
  }, []);

  const toggleFullscreen = () => (fullscreen === 'none' ? void enterFullscreen() : exitFullscreen());

  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) {
        setFullscreen((mode) => (mode === 'native' ? 'none' : mode));
        screen.orientation?.unlock?.();
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    if (fullscreen !== 'fake') return;
    document.body.classList.add('locked');
    return () => document.body.classList.remove('locked');
  }, [fullscreen]);

  useEffect(() => () => appFullscreen(false), []);

  const pip = typeof document !== 'undefined' && document.pictureInPictureEnabled;
  const togglePip = () => {
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => undefined);
    else video.current?.requestPictureInPicture().catch(() => undefined);
  };

  // ---- Клавиатура ----

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = video.current;
      if (!el) return;
      const actions: Record<string, () => void> = {
        ' ': togglePlay,
        k: togglePlay,
        ArrowLeft: () => seekBy(-5),
        ArrowRight: () => seekBy(5),
        j: () => seekBy(-10),
        l: () => seekBy(10),
        f: () => toggleFullscreen(),
        m: toggleMute,
        ArrowUp: () => (el.volume = Math.min(1, el.volume + 0.1)),
        ArrowDown: () => (el.volume = Math.max(0, el.volume - 0.1)),
        Escape: () => fullscreen === 'fake' && exitFullscreen(),
      };
      const action = actions[e.key] ?? actions[e.key.toLowerCase()];
      if (!action) return;
      e.preventDefault();
      action();
      poke();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // ---- Тапы: один — показать/скрыть панель, двойной по краям — перемотка ----

  const onSurface = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const now = performance.now();
    if (now - lastTap.current < 280) {
      window.clearTimeout(tapTimer.current);
      lastTap.current = 0;
      if (x < 0.35) seekBy(-10);
      else if (x > 0.65) seekBy(10);
      else toggleFullscreen();
      return;
    }
    lastTap.current = now;
    const mouse = e.pointerType === 'mouse';
    tapTimer.current = window.setTimeout(() => {
      if (menuOpen.current) {
        setMenu(null);
        return;
      }
      if (mouse) {
        togglePlay();
        poke();
      } else if (controls && video.current && !video.current.paused) {
        setControls(false);
      } else {
        poke();
      }
    }, mouse ? 200 : 280);
  };

  // ---- Опенинг и эндинг ----

  const { opening, ending } = episode;
  const shown = preview ?? time;
  const inOpening = Boolean(opening && time >= opening.start && time < opening.stop - 1);
  const inEnding = Boolean(ending && time >= ending.start && time < ending.stop - 1);

  useEffect(() => {
    autoSkipped.current = false;
    setCountdown(null);
  }, [episode.id]);

  useEffect(() => {
    if (inOpening && opening && settings.autoSkip && !autoSkipped.current && preview === null) {
      autoSkipped.current = true;
      seekTo(opening.stop);
      showFlash('Опенинг пропущен');
    }
  }, [inOpening, opening, settings.autoSkip, preview, seekTo, showFlash]);

  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      setCountdown(null);
      latest.current.onNext();
      return;
    }
    const timer = window.setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  // ---- Media Session: кнопки на экране блокировки и в шторке ----

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    session.metadata = new MediaMetadata({
      title: props.subtitle,
      artist: props.title,
      artwork: props.poster ? [{ src: props.poster, sizes: '512x512' }] : [],
    });
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // действие не поддерживается
      }
    };
    set('nexttrack', props.hasNext ? () => latest.current.onNext() : null);
    set('previoustrack', props.hasPrev ? () => latest.current.onPrev() : null);
    set('seekbackward', () => seekBy(-10));
    set('seekforward', () => seekBy(10));
    return () => {
      (['nexttrack', 'previoustrack', 'seekbackward', 'seekforward'] as MediaSessionAction[]).forEach((a) => set(a, null));
    };
  }, [episode.id, props.title, props.subtitle, props.poster, props.hasNext, props.hasPrev, seekBy]);

  // ---- Отрисовка ----

  const visible = controls || !playing || menu !== null || needsTap;
  const pct = (value: number) => (duration > 0 ? `${Math.min(100, (value / duration) * 100)}%` : '0%');
  const auto = settings.quality === 'auto';
  const qualityLabel = auto ? `Авто${activeHeight ? ` (${activeHeight}p)` : ''}` : `${settings.quality}p`;
  const qualityOptions = [...new Set(levels)].sort((a, b) => b - a);
  const canAuto = Boolean(hls.current ? levels.length > 1 : episode.master);
  const menuAsSheet = fullscreen === 'none' && (box.current?.clientHeight ?? 0) < 360;

  const onSeekInput = (value: number) => {
    setPreview(value);
    window.clearTimeout(commitTimer.current);
    commitTimer.current = window.setTimeout(() => {
      seekTo(value);
      setPreview(null);
    }, 150);
    poke();
  };

  const menuContent = (
    <>
      {menu === 'main' && (
        <>
          {qualityOptions.length > 0 && (
            <button className="pl-menu-row" onClick={() => setMenu('quality')}>
              <span>Качество</span>
              <b>{qualityLabel}</b>
              <Icon name="chevron" size={18} />
            </button>
          )}
          <button className="pl-menu-row" onClick={() => setMenu('speed')}>
            <span>Скорость</span>
            <b>{rate === 1 ? 'Обычная' : `${rate}×`}</b>
            <Icon name="chevron" size={18} />
          </button>
          <label className="pl-menu-row">
            <span>Пропускать опенинг</span>
            <input type="checkbox" checked={settings.autoSkip} onChange={(e) => updateSettings({ autoSkip: e.target.checked })} />
          </label>
          <label className="pl-menu-row">
            <span>Автопереход к следующей</span>
            <input type="checkbox" checked={settings.autoNext} onChange={(e) => updateSettings({ autoNext: e.target.checked })} />
          </label>
        </>
      )}
      {menu === 'quality' && (
        <>
          <button className="pl-menu-row pl-menu-back" onClick={() => setMenu('main')}>
            <Icon name="back" size={18} /> Качество
          </button>
          {canAuto && (
            <button className="pl-menu-row" onClick={() => setQuality('auto')}>
              <span>Авто{auto && activeHeight ? ` · сейчас ${activeHeight}p` : ''}</span>
              {auto && <Icon name="check" size={18} />}
            </button>
          )}
          {qualityOptions.map((q) => (
            <button key={q} className="pl-menu-row" onClick={() => setQuality(q)}>
              <span>
                {q}p{q >= 1080 ? ' FHD' : q >= 720 ? ' HD' : ''}
              </span>
              {settings.quality === q && <Icon name="check" size={18} />}
            </button>
          ))}
        </>
      )}
      {menu === 'speed' && (
        <>
          <button className="pl-menu-row pl-menu-back" onClick={() => setMenu('main')}>
            <Icon name="back" size={18} /> Скорость
          </button>
          {SPEEDS.map((s) => (
            <button key={s} className="pl-menu-row" onClick={() => setSpeed(s)}>
              <span>{s === 1 ? 'Обычная' : `${s}×`}</span>
              {rate === s && <Icon name="check" size={18} />}
            </button>
          ))}
        </>
      )}
    </>
  );

  return (
    <div
      ref={box}
      className={`player ${visible ? 'show-ui' : 'hide-ui'} ${fullscreen !== 'none' ? 'is-fs' : ''} ${fullscreen === 'fake' ? 'fake-fs' : ''}`}
      onPointerMove={(e) => e.pointerType === 'mouse' && poke()}
    >
      <video ref={video} playsInline preload="auto" poster={props.poster ?? undefined} />

      <div className="pl-surface" onPointerUp={onSurface} />

      {fullscreen !== 'none' && (
        <div className="pl-top">
          <button className="pl-btn" onClick={exitFullscreen} aria-label="Свернуть">
            <Icon name="back" />
          </button>
          <div className="pl-heading">
            <b>{props.title}</b>
            <span>{props.subtitle}</span>
          </div>
        </div>
      )}

      {waiting && !error && !needsTap && <span className="spinner pl-spinner" />}

      {!error && (needsTap || (!playing && !waiting) || (coarse && visible)) && countdown === null && (
        <div className="pl-center">
          {coarse && !needsTap && (
            <button className="pl-btn pl-round" onClick={() => seekBy(-10)} aria-label="Назад на 10 секунд">
              <Icon name="replay10" />
            </button>
          )}
          <button className="pl-btn pl-big" onClick={togglePlay} aria-label={playing ? 'Пауза' : 'Смотреть'}>
            <Icon name={playing ? 'pause' : 'play'} size={36} />
          </button>
          {coarse && !needsTap && (
            <button className="pl-btn pl-round" onClick={() => seekBy(10)} aria-label="Вперёд на 10 секунд">
              <Icon name="forward10" />
            </button>
          )}
        </div>
      )}

      {flash && <div className="pl-flash">{flash}</div>}

      {inOpening && opening && (!settings.autoSkip || autoSkipped.current) && (
        <button className="pl-skip" onClick={() => seekTo(opening.stop)}>
          Пропустить опенинг <Icon name="skip" size={18} />
        </button>
      )}
      {inEnding && ending && countdown === null && (
        <button className="pl-skip" onClick={() => (props.hasNext ? props.onNext() : seekTo(ending.stop))}>
          {props.hasNext ? 'Следующая серия' : 'Пропустить эндинг'} <Icon name="skip" size={18} />
        </button>
      )}

      {countdown !== null && (
        <div className="pl-overlay">
          <p>Следующая серия через {countdown}…</p>
          <div className="pl-overlay-actions">
            <button className="btn ghost" onClick={() => setCountdown(null)}>
              Отмена
            </button>
            <button className="btn" onClick={() => props.onNext()}>
              Смотреть
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="pl-overlay">
          <p>{error}</p>
          {episode.sources.length > 0 && (
            <button
              className="btn"
              onClick={() => {
                resumeAt.current = video.current?.currentTime || time;
                setAttempt((a) => a + 1);
              }}
            >
              Повторить
            </button>
          )}
        </div>
      )}

      <div className="pl-bottom">
        <div className="pl-bar">
          <div className="pl-track">
            <span className="pl-buffer" style={{ width: pct(buffered) }} />
            {opening && <span className="pl-mark" style={{ left: pct(opening.start), width: pct(opening.stop - opening.start) }} />}
            {ending && <span className="pl-mark" style={{ left: pct(ending.start), width: pct(ending.stop - ending.start) }} />}
            <span className="pl-played" style={{ width: pct(shown) }} />
          </div>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={Math.min(shown, duration || 0)}
            onChange={(e) => onSeekInput(Number(e.target.value))}
            aria-label="Перемотка"
          />
          {preview !== null && (
            <span className="pl-preview" style={{ left: pct(preview) }}>
              {clock(preview)}
            </span>
          )}
        </div>

        <div className="pl-controls">
          <button className="pl-btn" onClick={togglePlay} aria-label={playing ? 'Пауза' : 'Смотреть'}>
            <Icon name={playing ? 'pause' : 'play'} />
          </button>
          {props.hasPrev && (
            <button className="pl-btn" onClick={props.onPrev} aria-label="Предыдущая серия">
              <Icon name="prev" />
            </button>
          )}
          {props.hasNext && (
            <button className="pl-btn" onClick={props.onNext} aria-label="Следующая серия">
              <Icon name="next" />
            </button>
          )}
          <button className="pl-btn" onClick={toggleMute} aria-label={muted ? 'Включить звук' : 'Выключить звук'}>
            <Icon name={muted || volume === 0 ? 'mute' : 'volume'} />
          </button>
          {!coarse && (
            <input
              className="pl-volume"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => {
                const el = video.current!;
                el.volume = Number(e.target.value);
                el.muted = el.volume === 0;
              }}
              aria-label="Громкость"
            />
          )}
          <span className="pl-time">
            {clock(shown)} / {clock(duration)}
          </span>
          <span className="pl-spacer" />
          <button className={`pl-btn ${menu ? 'active' : ''}`} onClick={() => setMenu(menu ? null : 'main')} aria-label="Настройки">
            <Icon name="settings" />
          </button>
          {pip && (
            <button className="pl-btn" onClick={togglePip} aria-label="Картинка в картинке">
              <Icon name="pip" />
            </button>
          )}
          <button className="pl-btn" onClick={toggleFullscreen} aria-label={fullscreen !== 'none' ? 'Свернуть' : 'Во весь экран'}>
            <Icon name={fullscreen !== 'none' ? 'fullscreenExit' : 'fullscreen'} />
          </button>
        </div>
      </div>

      {menu && !menuAsSheet && (
        <div className="pl-menu" role="menu">
          {menuContent}
        </div>
      )}
      {/* На телефоне встроенный плеер низкий — меню выезжает шторкой снизу. */}
      <Sheet title="Настройки видео" open={menu !== null && menuAsSheet} onClose={() => setMenu(null)}>
        <div className="pl-menu-sheet" role="menu">
          {menuContent}
        </div>
      </Sheet>
    </div>
  );
}
