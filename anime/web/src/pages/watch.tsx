import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { releasePath, watchPath } from '../../../shared/links.ts';
import { frameSrc } from '../../../shared/players.ts';
import type { AppConfig, Dub, Episode, PlayerSource, PlayersResponse, Release, ReleaseUserState } from '../../../shared/types.ts';
import { useFetch } from '../api.ts';
import FramePlayer from '../components/frame-player.tsx';
import TorrentPlayer from '../components/torrent-player.tsx';
import { Icon } from '../components/icons.tsx';
import { BackLink, ErrorState, Spinner } from '../components/ui.tsx';
import { type Choice, lastChoice, resolveChoice, saveChoice, savedChoice } from '../players.ts';
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

/** Больше серий не бывает: защищает от ссылок вида startapp=w_1_999999999. */
const MAX_EPISODE = 3000;

/** Номер серии из адреса: от 0 до MAX_EPISODE (бывают и спецвыпуски вроде 12.5), иначе null. */
function validOrdinal(value: number): number | null {
  return Number.isFinite(value) && value >= 0 && value <= MAX_EPISODE ? value : null;
}

/** Серии AniLibria плюс серии 1…extraUpTo, которые пока есть только в других плеерах. */
function buildEntries(release: Release, extraUpTo: number | null, extra: number | null = null): Entry[] {
  const byOrdinal = new Map<number, Entry>(release.episodes.map((e) => [e.ordinal, { ordinal: e.ordinal, id: e.id, episode: e }]));
  // ID таких серий должен быть уникален и среди всех тайтлов: по нему сервер хранит прогресс.
  const add = (n: number) => !byOrdinal.has(n) && byOrdinal.set(n, { ordinal: n, id: `x${release.id}-${n}`, episode: null });
  for (let n = 1; extraUpTo && n <= Math.min(extraUpTo, MAX_EPISODE); n++) add(n);
  if (extra) add(extra);
  return [...byOrdinal.values()].sort((a, b) => a.ordinal - b.ordinal);
}

function ownPlayer(release: Release): PlayerSource | null {
  if (!release.episodes.some((e) => e.sources.length)) return null;
  return { id: 'anilibria', title: 'AniLibria', kind: 'hls', link: null, dubs: [], frame: null, events: null, lastEpisode: null, season: null };
}

/** «1080p», «4K»: показываем только хорошее качество, чтобы его было видно сразу. */
function qualityLabel(quality: number | null): string | null {
  if (!quality || quality < 1080) return null;
  return quality >= 2160 ? '4K' : `${quality}p`;
}

function dubTitle(dub: Dub): string | undefined {
  const parts = [dub.lastEpisode ? `Вышло серий: ${dub.lastEpisode}` : null, dub.quality ? `качество до ${dub.quality}p` : null];
  return parts.filter(Boolean).join(', ') || undefined;
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
  const nextTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!release) return;
    store
      .releaseState(release.id)
      .then(setState)
      .catch(() => setState({ favorite: false, subscribed: false, progress: [] }));
  }, [release, store]);

  // Пока список плееров грузится, сразу показываем свой плеер — если пользователь не
  // предпочитает другой (для этого тайтла или вообще в последний раз).
  const saved = useMemo(() => (release ? savedChoice(release.id) : null), [release]);
  const own = useMemo(() => (release ? ownPlayer(release) : null), [release]);
  const preferred = (picked ?? saved)?.player ?? lastChoice()?.player ?? 'anilibria';
  const playersLoaded = Boolean(playersQuery.data || playersQuery.error);
  const waitingForPlayers = !playersLoaded && preferred !== 'anilibria';
  const players = playersQuery.data?.players ?? (own && !waitingForPlayers ? [own] : []);
  const selection = resolveChoice(players, picked ?? saved);
  const player = selection?.player ?? null;
  const dub = selection?.dub ?? null;

  const wanted = validOrdinal(Number(ordinal));
  // Список серий общий для всех плееров: серии AniLibria и всё, что вышло в других плеерах.
  const otherUpTo = Math.max(
    0,
    ...players.filter((p) => p.kind !== 'hls').map((p) => Math.max(p.lastEpisode ?? 0, ...p.dubs.map((d) => d.lastEpisode ?? 0))),
  );
  const knownUpTo = Math.max(otherUpTo, ...(release?.episodes.map((e) => e.ordinal) ?? [0]));
  const extraUpTo = player?.kind === 'iframe' ? Math.max(otherUpTo, 1) : otherUpTo || null;
  // Открытую серию держим в списке, даже если не знаем, вышла ли она: во встроенном плеере
  // её могли выбрать в нём самом, а у AniLibria покажем «этой серии ещё нет».
  const extra = wanted !== null && Number.isInteger(wanted) && wanted > 0 && (player?.kind === 'iframe' || wanted <= knownUpTo) ? wanted : null;
  const entries = useMemo(() => (release ? buildEntries(release, extraUpTo, extra) : []), [release, extraUpTo, extra]);
  /** Есть ли серия в выбранном плеере и озвучке. */
  const limit = dub?.lastEpisode ?? player?.lastEpisode ?? null;
  const available = useCallback(
    (e: Entry) => {
      if (player?.kind === 'hls') return Boolean(e.episode?.sources.length);
      if (player?.kind === 'torrent' && !player.episodes?.includes(e.ordinal)) return false;
      return !(limit && e.ordinal > limit);
    },
    [player, limit],
  );
  const index = entries.findIndex((e) => e.ordinal === wanted);
  const entry = index >= 0 ? entries[index] : undefined;

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
        // Отметка «серия открыта» (duration = 0) не затирает сохранённую позицию.
        const keep = duration === 0 && previous && previous.duration > 0 ? previous : null;
        const next = {
          episodeId: target.id,
          ordinal: target.ordinal,
          time: keep ? keep.time : time,
          duration: keep ? keep.duration : duration,
          watched: Boolean(previous?.watched || options.watched || time / duration >= 0.92),
          updatedAt: new Date().toISOString(),
        };
        return { ...s, progress: [...s.progress.filter((p) => p.ordinal !== target.ordinal), next] };
      });
    },
    [release, store],
  );

  /** Выбор плеера; озвучку, если не указана, берём сохранённую для этого плеера или любимую. */
  const choose = (next: PlayerSource, nextDub?: Dub | null) => {
    if (!release) return;
    haptic('select');
    const resolvedDub = nextDub === undefined ? (resolveChoice([next], picked ?? saved)?.dub ?? null) : nextDub;
    const choice = { player: next.id, dub: resolvedDub?.id ?? null };
    setPicked(choice);
    saveChoice(release.id, choice, resolvedDub?.title ?? null);
  };

  // Адрес iframe меняем, только когда серию выбрали у нас. Если её сменил сам плеер,
  // он уже её показывает — перезагрузка сбросила бы просмотр.
  const frameLink = player?.kind === 'iframe' ? (dub?.link ?? player.link) : null;
  const frameKey = `${player?.id}:${dub?.id ?? ''}`;
  // nonce меняется при каждой пересборке: так iframe перезагрузится, даже если адрес тот же
  // (вернулись к исходной серии после того, как серию сменили внутри плеера).
  const [frame, setFrame] = useState<{ key: string; src: string; episode: number; nonce: number } | null>(null);
  const frameRef = useRef(frame);
  const frameNonce = useRef(0);
  useEffect(() => {
    const params = player?.frame;
    if (!frameLink || !player || !params || !entry) {
      frameRef.current = null;
      setFrame(null);
      return;
    }
    const current = frameRef.current;
    // Плеер, которому серию не передать (её выбирают в нём самом), при смене серии у нас
    // не перезагружаем: открылся бы тот же адрес, и просмотр начался бы заново.
    if (current && current.key === frameKey && (reportedEpisode.current === entry.ordinal || !params.episode)) return;
    reportedEpisode.current = entry.ordinal;
    const src = frameSrc(frameLink, { params, season: dub?.season ?? player.season, episode: entry.ordinal, hideDubs: Boolean(dub) });
    frameRef.current = { key: frameKey, src, episode: entry.ordinal, nonce: ++frameNonce.current };
    setFrame(frameRef.current);
  }, [frameLink, frameKey, player, dub, entry]);

  // Отложенный автопереход не должен сработать после ухода со страницы или смены серии.
  useEffect(() => () => window.clearTimeout(nextTimer.current), [frame?.nonce]);

  // Alloha не сообщает время просмотра. Чтобы тайтл попал в «Продолжить просмотр»,
  // запоминаем хотя бы, какую серию открыли (если прогресса по ней ещё нет). Серия
  // известна, если плеер открывает её по адресу или это фильм (одна серия).
  useEffect(() => {
    if (!frame || !player || player.events || !(player.frame?.episode || player.lastEpisode === 1) || !state) return;
    if (state.progress.some((p) => p.ordinal === frame.episode)) return;
    saveProgress(frame.episode, 0, 0, { watched: false, leaving: false });
    // Только при смене серии или плеера, а не при каждом обновлении прогресса.
  }, [frame?.nonce, state === null]);

  const onFrameEpisode = useCallback(
    (episode: number) => {
      reportedEpisode.current = episode;
      if (episode !== wanted) goTo(episode);
    },
    [wanted, goTo],
  );

  // Kodik сам может включить следующую серию. Если через пару секунд он этого не сделал — переключаем мы
  // (только на серию, которая есть в этом плеере и озвучке, и без спецвыпусков вроде 12.5).
  const onFrameEnded = useCallback(() => {
    if (!getSettings().autoNext) return;
    const endedOn = reportedEpisode.current;
    const next = entries.find((e) => endedOn !== null && e.ordinal > endedOn && Number.isInteger(e.ordinal) && available(e));
    if (!next) return;
    window.clearTimeout(nextTimer.current);
    nextTimer.current = window.setTimeout(() => {
      if (reportedEpisode.current === endedOn) goTo(next.ordinal);
    }, 2500);
  }, [entries, goTo, available]);

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
    if (!playersLoaded) return <Spinner label="Ищу плееры…" />;
    const first = entries[0];
    return (
      <div className="page">
        <BackLink />
        <ErrorState error={new Error(first ? 'Такой серии нет' : 'У этого тайтла пока нет серий ни в одном плеере')} />
        {first && (
          <Link to={watchPath(release.alias || release.id, first.ordinal)} replace className="btn wide">
            К {first.ordinal} серии
          </Link>
        )}
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
  /** Первый другой плеер, где эта серия есть (у раздачи — свой список серий). */
  const fallback = others.find((p) => {
    if (p.kind === 'torrent') return Boolean(p.episodes?.includes(entry.ordinal));
    const last = Math.max(p.lastEpisode ?? 0, ...p.dubs.map((d) => d.lastEpisode ?? 0));
    return last === 0 || last >= entry.ordinal;
  });
  // Серию не передать в плеер (сезон неизвестен) — её выбирают в нём самом. У фильма серий нет.
  const pickEpisodeInside = player?.kind === 'iframe' && !player.frame?.episode && player.lastEpisode !== 1;

  let screen;
  if (!player && playersLoaded) {
    screen = (
      <div className="player placeholder notice-screen">
        <p>{release.blocked ? 'Правообладатель ограничил показ этого тайтла.' : 'Видео пока нет ни в одном плеере.'}</p>
      </div>
    );
  } else if (state === null || !player) {
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
        {fallback && (
          <button className="btn" onClick={() => choose(fallback)}>
            Смотреть в {fallback.title}
          </button>
        )}
      </div>
    );
  } else if (player.kind === 'torrent') {
    screen = available(entry) ? (
      <TorrentPlayer
        key={`${player.id}:${dub?.id ?? ''}:${entry.ordinal}`}
        player={player.id}
        dub={dub?.id ?? null}
        ordinal={entry.ordinal}
        title={release.title}
        subtitle={subtitle}
        poster={entry.episode?.preview ?? release.poster}
        startAt={startAt}
        hasPrev={hasPrev}
        hasNext={hasNext}
        onPrev={() => go(index - 1)}
        onNext={() => go(index + 1)}
        onProgress={(time, duration, options) => saveProgress(entry.ordinal, time, duration, options)}
      />
    ) : (
      <div className="player placeholder notice-screen">
        <p>
          В {dub?.title ? `озвучке «${dub.title}»` : 'этой раздаче'} {entry.ordinal}-й серии нет.
        </p>
      </div>
    );
  } else if (frame) {
    screen = (
      <FramePlayer
        key={frame.nonce}
        maxEpisode={MAX_EPISODE}
        events={player.events}
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
                onClick={() => p.id !== player?.id && choose(p)}
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
                    title={dubTitle(d)}
                  >
                    {dubLabel(d)}
                    {qualityLabel(d.quality) && <span className="chip-hd">{qualityLabel(d.quality)}</span>}
                    {d.lastEpisode !== null && <span className="chip-count">{d.lastEpisode}</span>}
                  </button>
                );
              })}
            </div>
          )}
          {player?.kind === 'iframe' && (player.dubs.length === 0 || pickEpisodeInside) && (
            <p className="hint">
              {pickEpisodeInside && player.dubs.length === 0
                ? 'Серию и озвучку выбирают внутри плеера.'
                : pickEpisodeInside
                  ? 'Серию выбирают внутри плеера.'
                  : 'Озвучку выбирают внутри плеера.'}
            </p>
          )}
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
