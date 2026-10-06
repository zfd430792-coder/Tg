import { useEffect, useMemo, useState } from 'react';
import { releaseStartParam, watchPath } from '../../../shared/links.ts';
import type { AppConfig, EpisodeProgress, PlayersResponse, Release, ReleaseUserState } from '../../../shared/types.ts';
import { useFetch } from '../api.ts';
import { Icon } from '../components/icons.tsx';
import { BackLink, ErrorState, Poster, Progress, Spinner } from '../components/ui.tsx';
import { episodesCount, minutes, plural } from '../format.ts';
import { Link, navigate } from '../router.ts';
import { ensureWriteAccess, haptic, shareLink, tg } from '../telegram.ts';
import { updateSettings, userData, useSettings } from '../user.ts';

const emptyState: ReleaseUserState = { favorite: false, subscribed: false, progress: [] };

export function shareUrl(config: AppConfig, release: Release): string {
  if (config.botUsername && config.appShortName) {
    return `https://t.me/${config.botUsername}/${config.appShortName}?startapp=${releaseStartParam(release.id)}`;
  }
  if (config.botUsername) return `https://t.me/${config.botUsername}?start=${releaseStartParam(release.id)}`;
  return `${config.siteUrl ?? location.origin}/release/${release.alias}`;
}

/** С какой серии продолжить: первая недосмотренная после последней открытой. */
export function resumeEpisode(release: Release, progress: EpisodeProgress[]): { ordinal: number; label: string } | null {
  if (release.episodes.length === 0) return null;
  if (progress.length === 0) return { ordinal: release.episodes[0].ordinal, label: 'Смотреть' };
  const last = [...progress].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!last.watched) return { ordinal: last.ordinal, label: `Продолжить · ${last.ordinal} серия` };
  const next = release.episodes.find((e) => e.ordinal > last.ordinal);
  if (next) return { ordinal: next.ordinal, label: `Смотреть ${next.ordinal} серию` };
  return { ordinal: release.episodes[0].ordinal, label: 'Пересмотреть' };
}

export function ReleasePage({ id, config }: { id: string; config: AppConfig }) {
  const { data: release, error, loading, reload } = useFetch<Release>(`/api/releases/${encodeURIComponent(id)}`);
  const playersQuery = useFetch<PlayersResponse>(release ? `/api/releases/${encodeURIComponent(id)}/players` : null, 10 * 60_000);
  const [state, setState] = useState<ReleaseUserState>(emptyState);
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const settings = useSettings();
  const store = userData();

  useEffect(() => {
    if (!release) return;
    document.title = `${release.title} — ${config.appName}`;
    store
      .releaseState(release.id)
      .then(setState)
      .catch(() => setState(emptyState));
  }, [release, store, config.appName]);

  const progress = useMemo(() => new Map(state.progress.map((p) => [p.episodeId, p])), [state.progress]);

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

  const resume = resumeEpisode(release, state.progress);
  const players = playersQuery.data?.players ?? [];
  const others = players.filter((p) => p.kind === 'iframe');
  const othersUpTo = Math.max(0, ...others.map((p) => p.lastEpisode ?? 0));
  const episodes = settings.episodesDesc ? [...release.episodes].reverse() : release.episodes;
  const meta = [release.type, release.year, release.season, release.ageRating].filter(Boolean).join(' · ');
  const done = state.progress.filter((p) => p.watched).length;

  const toggleFavorite = async () => {
    const on = !state.favorite;
    setState((s) => ({ ...s, favorite: on }));
    haptic(on ? 'success' : 'light');
    try {
      await store.setFavorite(release, on);
    } catch (e) {
      setState((s) => ({ ...s, favorite: !on }));
      setNotice((e as Error).message);
    }
  };

  const toggleSubscribe = async () => {
    if (store.mode === 'local') {
      setNotice('Уведомления о новых сериях присылает бот — откройте приложение в Telegram.');
      return;
    }
    const on = !state.subscribed;
    if (on && !(await ensureWriteAccess())) {
      setNotice('Без разрешения писать вам бот не сможет прислать уведомление.');
      return;
    }
    setState((s) => ({ ...s, subscribed: on }));
    haptic(on ? 'success' : 'light');
    try {
      await store.setSubscribed(release.id, on);
      setNotice(on ? 'Пришлю в Telegram, когда выйдет новая серия 🔔' : null);
    } catch (e) {
      setState((s) => ({ ...s, subscribed: !on }));
      setNotice((e as Error).message);
    }
  };

  return (
    <div className="page release">
      <div className="hero">
        {release.poster && <div className="hero-bg" style={{ backgroundImage: `url("${release.poster}")` }} />}
        {!tg && <BackLink />}
        <div className="hero-body">
          <Poster src={release.poster} alt={release.title} className="hero-poster" />
          <div className="hero-info">
            <h1>{release.title}</h1>
            {release.titleEn && <p className="hint">{release.titleEn}</p>}
            <p className="meta">{meta}</p>
            <p className="meta">
              {release.isOngoing ? <span className="badge inline">выходит</span> : <span className="badge inline muted">завершён</span>}{' '}
              {release.episodesTotal ? episodesCount(release.episodesTotal) : episodesCount(release.episodes.length)}
              {release.averageDuration ? ` по ${release.averageDuration} мин` : ''}
            </p>
          </div>
        </div>
      </div>

      <div className="actions">
        {resume && !release.blocked ? (
          <Link to={watchPath(release.alias || release.id, resume.ordinal)} className="btn primary grow">
            <Icon name="play" size={20} /> {resume.label}
          </Link>
        ) : others.length > 0 ? (
          <Link to={watchPath(release.alias || release.id, 1)} className="btn primary grow">
            <Icon name="play" size={20} /> Смотреть в {others[0].title}
          </Link>
        ) : (
          <button className="btn primary grow" disabled>
            {release.blocked ? 'Недоступно в вашем регионе' : 'Серий пока нет'}
          </button>
        )}
        <button className={`icon-btn big ${state.favorite ? 'on' : ''}`} onClick={toggleFavorite} aria-pressed={state.favorite} aria-label="В избранное" title="В избранное">
          <Icon name="heart" fill={state.favorite ? 'currentColor' : 'none'} />
        </button>
        <button className={`icon-btn big ${state.subscribed ? 'on' : ''}`} onClick={toggleSubscribe} aria-pressed={state.subscribed} aria-label="Уведомлять о новых сериях" title="Уведомлять о новых сериях">
          <Icon name="bell" fill={state.subscribed ? 'currentColor' : 'none'} />
        </button>
        <button className="icon-btn big" onClick={() => shareLink(shareUrl(config, release), `Смотри «${release.title}»`)} aria-label="Поделиться" title="Поделиться">
          <Icon name="share" />
        </button>
      </div>

      {notice && (
        <p className="notice" onClick={() => setNotice(null)}>
          {notice}
        </p>
      )}

      {release.notification && <p className="notice soft">{release.notification}</p>}

      {release.genres.length > 0 && (
        <div className="chips">
          {release.genres.map((g) => (
            <Link key={g.id} to={`/catalog?genres=${g.id}`} className="chip">
              {g.name}
            </Link>
          ))}
        </div>
      )}

      {release.description && (
        <div className={`description ${expanded ? 'open' : ''}`} onClick={() => setExpanded(!expanded)}>
          <p>{release.description}</p>
          {!expanded && <span className="more">ещё</span>}
        </div>
      )}

      {release.voices.length > 0 && <p className="hint">Озвучка AniLibria: {release.voices.join(', ')}</p>}
      {players.length > 0 && (
        <p className="hint">
          Плееры:{' '}
          {players
            .map((p) => (p.dubs.length > 1 ? `${p.title} (${p.dubs.length} ${plural(p.dubs.length, 'озвучка', 'озвучки', 'озвучек')})` : p.title))
            .join(' · ')}
        </p>
      )}

      <div className="section-head">
        <h2>
          Серии{done ? <span className="hint"> · просмотрено {done}</span> : null}
        </h2>
        {release.episodes.length > 1 && (
          <button className="icon-btn" onClick={() => updateSettings({ episodesDesc: !settings.episodesDesc })} aria-label="Порядок серий" title="Порядок серий">
            <Icon name="sort" size={20} />
          </button>
        )}
      </div>

      {release.blocked && <p className="notice">Правообладатель ограничил показ этого тайтла.</p>}

      <ol className="episodes">
        {episodes.map((episode) => {
          const p = progress.get(episode.id);
          const share = p && p.duration ? Math.min(1, p.time / p.duration) : 0;
          return (
            <li key={episode.id}>
              <Link to={watchPath(release.alias || release.id, episode.ordinal)} className={`episode ${p?.watched ? 'watched' : ''}`}>
                <div className="episode-thumb">
                  {episode.preview ? <img src={episode.preview} alt="" loading="lazy" /> : <span>{episode.ordinal}</span>}
                  {p?.watched && (
                    <span className="episode-check">
                      <Icon name="check" size={16} />
                    </span>
                  )}
                  {share > 0 && !p?.watched && <Progress value={share} />}
                </div>
                <div className="episode-text">
                  <b>{episode.ordinal} серия</b>
                  {episode.name && <span>{episode.name}</span>}
                  <span className="hint">{minutes(episode.duration)}</span>
                </div>
              </Link>
            </li>
          );
        })}
      </ol>

      {release.episodes.length === 0 && others.length > 0 && (
        <p className="hint center">
          У AniLibria серий пока нет — смотрите в {others[0].title}
          {othersUpTo ? `: вышло ${episodesCount(othersUpTo)}` : ''}.
        </p>
      )}
      {release.episodes.length === 0 && others.length === 0 && !release.blocked && !playersQuery.loading && (
        <p className="hint center">Серии ещё не вышли. Нажмите 🔔 — пришлём, когда появится первая.</p>
      )}

      {store.mode === 'local' && config.botUsername && (
        <p className="hint center">
          Хотите уведомления о новых сериях?{' '}
          <a href={shareUrl(config, release)} target="_blank" rel="noreferrer">
            Откройте в Telegram
          </a>
        </p>
      )}

      <button className="btn ghost wide" onClick={() => navigate('/catalog')}>
        Весь каталог
      </button>
    </div>
  );
}
