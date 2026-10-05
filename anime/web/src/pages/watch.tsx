import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { releasePath, watchPath } from '../../../shared/links.ts';
import type { AppConfig, Release, ReleaseUserState } from '../../../shared/types.ts';
import { useFetch } from '../api.ts';
import { Icon } from '../components/icons.tsx';
import { BackLink, ErrorState, Spinner } from '../components/ui.tsx';
import { Link, navigate } from '../router.ts';
import { tg } from '../telegram.ts';
import { userData } from '../user.ts';

// hls.js весит ~400 КБ — грузим его только на странице просмотра.
const Player = lazy(() => import('../components/player.tsx'));

export function WatchPage({ id, ordinal, config }: { id: string; ordinal: string; config: AppConfig }) {
  const { data: release, error, loading, reload } = useFetch<Release>(`/api/releases/${encodeURIComponent(id)}`);
  const [state, setState] = useState<ReleaseUserState | null>(null);
  const store = userData();
  const chips = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!release) return;
    store
      .releaseState(release.id)
      .then(setState)
      .catch(() => setState({ favorite: false, subscribed: false, progress: [] }));
  }, [release, store]);

  const index = release ? Math.max(0, release.episodes.findIndex((e) => e.ordinal === Number(ordinal))) : 0;
  const episode = release?.episodes[index];

  useEffect(() => {
    if (release && episode) document.title = `${episode.ordinal} серия — ${release.title} — ${config.appName}`;
  }, [release, episode, config.appName]);

  // Прокручиваем только список серий, чтобы текущая была видна; саму страницу не трогаем.
  const ready = state !== null;
  useEffect(() => {
    const box = chips.current;
    const chip = box?.querySelector<HTMLElement>('.current');
    if (!box || !chip) return;
    const offset = chip.getBoundingClientRect().top - box.getBoundingClientRect().top;
    box.scrollTop += offset - box.clientHeight / 2 + chip.offsetHeight / 2;
  }, [episode?.id, ready]);

  const go = useCallback(
    (i: number) => {
      if (!release || !release.episodes[i]) return;
      navigate(watchPath(release.alias || release.id, release.episodes[i].ordinal), { replace: true });
    },
    [release],
  );

  const onProgress = useCallback(
    (time: number, duration: number, options: { watched: boolean; leaving: boolean }) => {
      if (!release || !episode) return;
      const input = { releaseId: release.id, episodeId: episode.id, ordinal: episode.ordinal, time, duration, watched: options.watched };
      store.saveProgress(release, input, options.leaving).catch(() => undefined);
      setState((s) => {
        if (!s) return s;
        const previous = s.progress.find((p) => p.episodeId === episode.id);
        const entry = {
          episodeId: episode.id,
          ordinal: episode.ordinal,
          time,
          duration,
          watched: Boolean(previous?.watched || options.watched || time / duration >= 0.92),
          updatedAt: new Date().toISOString(),
        };
        return { ...s, progress: [...s.progress.filter((p) => p.episodeId !== episode.id), entry] };
      });
    },
    [release, episode, store],
  );

  if (loading) return <Spinner />;
  if (error) {
    return (
      <div className="page">
        <BackLink />
        <ErrorState error={error} onRetry={reload} />
      </div>
    );
  }
  if (!release) return null;
  if (!episode) {
    return (
      <div className="page">
        <BackLink />
        <ErrorState error={new Error('У этого тайтла пока нет серий')} />
      </div>
    );
  }

  const saved = state?.progress.find((p) => p.episodeId === episode.id);
  const startAt = saved && !saved.watched && saved.time > 5 && saved.time < saved.duration - 20 ? saved.time - 2 : 0;
  const watched = new Set(state?.progress.filter((p) => p.watched).map((p) => p.episodeId));
  const hasPrev = index > 0;
  const hasNext = index < release.episodes.length - 1;

  return (
    <div className="page watch">
      {state === null ? (
        <div className="player placeholder" />
      ) : (
        <Suspense fallback={<div className="player placeholder" />}>
          <Player
            key={episode.id}
            episode={episode}
            title={release.title}
            subtitle={`${episode.ordinal} серия${episode.name ? ` · ${episode.name}` : ''}`}
            poster={episode.preview ?? release.poster}
            startAt={startAt}
            hasPrev={hasPrev}
            hasNext={hasNext}
            onPrev={() => go(index - 1)}
            onNext={() => go(index + 1)}
            onProgress={onProgress}
          />
        </Suspense>
      )}

      <div className="watch-info">
        {!tg && <BackLink />}
        <div className="watch-titles">
          <Link to={releasePath(release.alias || release.id)} className="watch-release">
            {release.title} <Icon name="chevron" size={16} />
          </Link>
          <h1>
            {episode.ordinal} серия{episode.name ? <span className="hint"> · {episode.name}</span> : null}
          </h1>
        </div>
      </div>

      <div className="actions">
        <button className="btn ghost grow" disabled={!hasPrev} onClick={() => go(index - 1)}>
          <Icon name="prev" size={18} /> Предыдущая
        </button>
        <button className="btn ghost grow" disabled={!hasNext} onClick={() => go(index + 1)}>
          Следующая <Icon name="next" size={18} />
        </button>
      </div>

      {release.voices.length > 0 && <p className="hint">Озвучка: {release.voices.join(', ')}</p>}

      <div className="section-head">
        <h2>Все серии</h2>
        <span className="hint">
          {index + 1} из {release.episodes.length}
        </span>
      </div>
      <div className="ep-chips" ref={chips}>
        {release.episodes.map((e) => (
          <Link
            key={e.id}
            to={watchPath(release.alias || release.id, e.ordinal)}
            replace
            className={`ep-chip ${e.id === episode.id ? 'current' : ''} ${watched.has(e.id) ? 'watched' : ''}`}
          >
            {e.ordinal}
          </Link>
        ))}
      </div>
    </div>
  );
}
