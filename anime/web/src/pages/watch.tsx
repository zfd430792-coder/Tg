import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { releasePath, watchPath } from '../../../shared/links.ts';
import { frameSrc } from '../../../shared/players.ts';
import type { AppConfig, Dub, Episode, PlayerSource, PlayersResponse, Release, ReleaseUserState } from '../../../shared/types.ts';
import { useFetch } from '../api.ts';
import FramePlayer from '../components/frame-player.tsx';
import { Icon } from '../components/icons.tsx';
import { BackLink, ErrorState, Spinner } from '../components/ui.tsx';
import { type Choice, resolveChoice, saveChoice, savedChoice } from '../players.ts';
import { Link, navigate } from '../router.ts';
import { haptic, tg } from '../telegram.ts';
import { getSettings, userData } from '../user.ts';

// hls.js весит ~400 КБ — грузим его только на странице просмотра.
const Player = lazy(() => import('../components/player.tsx'));

/** Серия в общем списке: из AniLibria или только из другого плеера (тогда episode = null). */
interface Entry {
  ordinal: number;
  id: string;
  episode: Episode | null;
}

/** Серии AniLibria плюс те, что уже вышли в выбранной озвучке другого плеера. */
function buildEntries(release: Release, extraUpTo: number | null): Entry[] {
  const byOrdinal = new Map<number, Entry>(release.episodes.map((e) => [e.ordinal, { ordinal: e.ordinal, id: e.id, episode: e }]));
  for (let n = 1; extraUpTo && n <= extraUpTo; n++) {
    if (!byOrdinal.has(n)) byOrdinal.set(n, { ordinal: n, id: `n${n}`, episode: null });
  }
  return [...byOrdinal.values()].sort((a, b) => a.ordinal - b.ordinal);
}

function ownPlayer(release: Release): PlayerSource | null {
  if (!release.episodes.some((e) => e.sources.length)) return null;
  return { id: 'anilibria', title: 'AniLibria', kind: 'hls', link: null, dubs: [], episodeParams: null, lastEpisode: null, season: null };
}

function dubLabel(dub: Dub): string {
  const parts = [dub.title];
  if (dub.type === 'subtitles' && !/суб/i.test(dub.title)) parts.push('суб.');
  return parts.join(' · ');
}

export function WatchPage({ id, ordinal, config }: { id: string; ordinal: string; config: AppConfig }) {
  const { data: release, error, loading, reload } = useFetch<Release>(`/api/releases/${encodeURIComponent(id)}`);
  const playersQuery = useFetch<PlayersResponse>(release ? `/api/releases/${encodeURIComponent(id)}/players` : null, 10 * 60_000);
  const [state, setState] = useState<ReleaseUserState | null>(null);
  const [picked, setPicked] = useState<Choice | null>(null);
  const store = userData();
  const chips = useRef<HTMLDivElement>(null);
  const reportedEpisode = useRef<number | null>(null);

  useEffect(() => {
    if (!release) return;
    store
      .releaseState(release.id)
      .then(setState)
      .catch(() => setState({ favorite: false, subscribed: false, progress: [] }));
  }, [release, store]);

  // Пока список плееров грузится, сразу показываем свой плеер — если пользователь не выбирал другой.
  const saved = useMemo(() => (release ? savedChoice(release.id) : null), [release]);
  const own = useMemo(() => (release ? ownPlayer(release) : null), [release]);
  const waitingForPlayers = !playersQuery.data && !playersQuery.error && Boolean(saved && saved.player !== 'anilibria');
  const players = playersQuery.data?.players ?? (own && !waitingForPlayers ? [own] : []);
  const selection = resolveChoice(players, picked ?? saved);
  const player = selection?.player ?? null;
  const dub = selection?.dub ?? null;

  const wanted = Number(ordinal);
  // Список серий общий для всех плееров: серии AniLibria и всё, что вышло в других
  // плеерах. Во встроенном плеере добавляем и открытую сейчас серию — её могли выбрать
  // в самом плеере, даже если мы не знаем, сколько серий вышло.
  const otherUpTo = Math.max(
    0,
    ...players.filter((p) => p.kind === 'iframe').map((p) => Math.max(p.lastEpisode ?? 0, ...p.dubs.map((d) => d.lastEpisode ?? 0))),
  );
  const extraUpTo =
    player?.kind === 'iframe' ? Math.max(otherUpTo, Number.isInteger(wanted) && wanted > 0 ? wanted : 0, 1) : otherUpTo || null;
  const entries = useMemo(() => (release ? buildEntries(release, extraUpTo) : []), [release, extraUpTo]);
  /** Есть ли серия в выбранном плеере и озвучке. */
  const available = (e: Entry) =>
    player?.kind === 'hls' ? Boolean(e.episode?.sources.length) : !(dub?.lastEpisode && e.ordinal > dub.lastEpisode);
  const index = Math.max(0, entries.findIndex((e) => e.ordinal === wanted));
  const entry = entries[index] as Entry | undefined;

  useEffect(() => {
    if (release && entry) document.title = `${entry.ordinal} серия — ${release.title} — ${config.appName}`;
  }, [release, entry, config.appName]);

  // Прокручиваем только список серий, чтобы текущая была видна; саму страницу не трогаем.
  const ready = state !== null;
  useEffect(() => {
    const box = chips.current;
    const chip = box?.querySelector<HTMLElement>('.current');
    if (!box || !chip) return;
    const offset = chip.getBoundingClientRect().top - box.getBoundingClientRect().top;
    box.scrollTop += offset - box.clientHeight / 2 + chip.offsetHeight / 2;
  }, [entry?.ordinal, ready]);

  const goTo = useCallback(
    (target: number) => {
      if (!release) return;
      navigate(watchPath(release.alias || release.id, target), { replace: true });
    },
    [release],
  );
  const go = (i: number) => entries[i] && goTo(entries[i].ordinal);

  // Прогресс одинаково пишется для любого плеера: по номеру серии.
  const saveProgress = useCallback(
    (episodeOrdinal: number, time: number, duration: number, options: { watched: boolean; leaving: boolean }) => {
      if (!release) return;
      const target = buildEntries(release, episodeOrdinal).find((e) => e.ordinal === episodeOrdinal);
      if (!target) return;
      const input = { releaseId: release.id, episodeId: target.id, ordinal: target.ordinal, time, duration, watched: options.watched };
      store.saveProgress(release, input, options.leaving).catch(() => undefined);
      setState((s) => {
        if (!s) return s;
        const previous = s.progress.find((p) => p.ordinal === target.ordinal);
        const next = {
          episodeId: target.id,
          ordinal: target.ordinal,
          time,
          duration,
          watched: Boolean(previous?.watched || options.watched || time / duration >= 0.92),
          updatedAt: new Date().toISOString(),
        };
        return { ...s, progress: [...s.progress.filter((p) => p.ordinal !== target.ordinal), next] };
      });
    },
    [release, store],
  );

  const choose = (next: PlayerSource, nextDub: Dub | null) => {
    if (!release) return;
    haptic('select');
    const choice = { player: next.id, dub: nextDub?.id ?? null };
    setPicked(choice);
    saveChoice(release.id, choice, nextDub?.title ?? null);
  };

  // Адрес iframe меняем, только когда серию выбрали у нас. Если её сменил сам плеер,
  // он уже её показывает — перезагрузка сбросила бы просмотр.
  const frameLink = player?.kind === 'iframe' ? (dub?.link ?? player.link) : null;
  const frameKey = `${player?.id}:${dub?.id ?? ''}`;
  const [frame, setFrame] = useState<{ key: string; src: string; episode: number } | null>(null);
  useEffect(() => {
    if (!frameLink || !player || !entry) {
      setFrame(null);
      return;
    }
    setFrame((current) => {
      if (current && current.key === frameKey && reportedEpisode.current === entry.ordinal) return current;
      reportedEpisode.current = entry.ordinal;
      const src = frameSrc(frameLink, {
        params: player.episodeParams,
        season: dub?.season ?? player.season,
        episode: entry.ordinal,
        hideDubs: Boolean(dub),
      });
      return { key: frameKey, src, episode: entry.ordinal };
    });
  }, [frameLink, frameKey, player, dub, entry]);

  const onFrameEpisode = useCallback(
    (episode: number) => {
      reportedEpisode.current = episode;
      if (episode !== wanted) goTo(episode);
    },
    [wanted, goTo],
  );

  // Kodik сам может включить следующую серию. Если через пару секунд он этого не сделал — переключаем мы.
  const onFrameEnded = useCallback(() => {
    if (!getSettings().autoNext) return;
    const endedOn = reportedEpisode.current;
    const next = entries.find((e) => endedOn !== null && e.ordinal > endedOn);
    if (!next) return;
    window.setTimeout(() => {
      if (reportedEpisode.current === endedOn) goTo(next.ordinal);
    }, 2500);
  }, [entries, goTo]);

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
  if (!entry) {
    if (playersQuery.loading || waitingForPlayers) return <Spinner label="Ищу плееры…" />;
    return (
      <div className="page">
        <BackLink />
        <ErrorState error={new Error('У этого тайтла пока нет серий ни в одном плеере')} />
      </div>
    );
  }

  const progress = state?.progress.find((p) => p.ordinal === entry.ordinal);
  const startAt = progress && !progress.watched && progress.time > 5 && progress.time < progress.duration - 20 ? progress.time - 2 : 0;
  const watched = new Set(state?.progress.filter((p) => p.watched).map((p) => p.ordinal));
  const hasPrev = index > 0;
  const hasNext = index < entries.length - 1;
  const subtitle = `${entry.ordinal} серия${entry.episode?.name ? ` · ${entry.episode.name}` : ''}`;
  const others = players.filter((p) => p.id !== 'anilibria');

  let screen;
  if (state === null || !player) {
    screen = <div className="player placeholder" />;
  } else if (player.kind === 'hls' && entry.episode) {
    screen = (
      <Suspense fallback={<div className="player placeholder" />}>
        <Player
          key={entry.id}
          episode={entry.episode}
          title={release.title}
          subtitle={subtitle}
          poster={entry.episode.preview ?? release.poster}
          startAt={startAt}
          hasPrev={hasPrev}
          hasNext={hasNext}
          onPrev={() => go(index - 1)}
          onNext={() => go(index + 1)}
          onProgress={(time, duration, options) => saveProgress(entry.ordinal, time, duration, options)}
        />
      </Suspense>
    );
  } else if (player.kind === 'hls') {
    screen = (
      <div className="player placeholder notice-screen">
        <p>В озвучке AniLibria {entry.ordinal}-й серии ещё нет.</p>
        {others[0] && (
          <button className="btn" onClick={() => choose(others[0], others[0].dubs[0] ?? null)}>
            Смотреть в {others[0].title}
          </button>
        )}
      </div>
    );
  } else if (frame) {
    screen = (
      <FramePlayer
        src={frame.src}
        episode={frame.episode}
        title={`${release.title} — ${subtitle}`}
        onProgress={saveProgress}
        onEpisode={onFrameEpisode}
        onEnded={onFrameEnded}
      />
    );
  } else {
    screen = <div className="player placeholder" />;
  }

  return (
    <div className="page watch">
      {screen}

      {players.length > 0 && (
        <div className="sources">
          <div className="source-row" role="tablist" aria-label="Плеер">
            {players.map((p) => (
              <button
                key={p.id}
                role="tab"
                aria-selected={p.id === player?.id}
                className={`chip ${p.id === player?.id ? 'active' : ''}`}
                onClick={() => p.id !== player?.id && choose(p, null)}
              >
                {p.title}
                {p.dubs.length > 1 && <span className="chip-count">{p.dubs.length}</span>}
              </button>
            ))}
            {playersQuery.loading && <span className="hint source-loading">ищу плееры…</span>}
          </div>
          {player && player.dubs.length > 0 && (
            <div className="source-row dubs" aria-label="Озвучка">
              {player.dubs.map((d) => {
                const missing = d.lastEpisode !== null && d.lastEpisode < entry.ordinal;
                return (
                  <button
                    key={d.id}
                    className={`chip ${d.id === dub?.id ? 'active' : ''} ${missing ? 'missing' : ''}`}
                    onClick={() => d.id !== dub?.id && choose(player, d)}
                    title={d.lastEpisode ? `Вышло серий: ${d.lastEpisode}` : undefined}
                  >
                    {dubLabel(d)}
                    {d.lastEpisode !== null && <span className="chip-count">{d.lastEpisode}</span>}
                  </button>
                );
              })}
            </div>
          )}
          {player?.kind === 'iframe' && player.dubs.length === 0 && <p className="hint">Озвучку выбирают внутри плеера.</p>}
        </div>
      )}

      <div className="watch-info">
        {!tg && <BackLink />}
        <div className="watch-titles">
          <Link to={releasePath(release.alias || release.id)} className="watch-release">
            {release.title} <Icon name="chevron" size={16} />
          </Link>
          <h1>
            {entry.ordinal} серия{entry.episode?.name ? <span className="hint"> · {entry.episode.name}</span> : null}
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

      {player?.id === 'anilibria' && release.voices.length > 0 && <p className="hint">Озвучка AniLibria: {release.voices.join(', ')}</p>}

      <div className="section-head">
        <h2>Все серии</h2>
        <span className="hint">
          {index + 1} из {entries.length}
        </span>
      </div>
      <div className="ep-chips" ref={chips}>
        {entries.map((e) => (
          <Link
            key={e.id}
            to={watchPath(release.alias || release.id, e.ordinal)}
            replace
            className={`ep-chip ${e.ordinal === entry.ordinal ? 'current' : ''} ${watched.has(e.ordinal) ? 'watched' : ''} ${available(e) ? '' : 'missing'}`}
            title={available(e) ? undefined : `В ${dub?.title ?? player?.title ?? 'этом плеере'} этой серии пока нет`}
          >
            {e.ordinal}
          </Link>
        ))}
      </div>
    </div>
  );
}
