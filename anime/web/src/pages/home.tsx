import { useEffect, useState } from 'react';
import { releasePath, watchPath } from '../../../shared/links.ts';
import type { HistoryItem, ReleaseCard, ScheduleDay } from '../../../shared/types.ts';
import { api, useFetch } from '../api.ts';
import { Icon } from '../components/icons.tsx';
import { Empty, ErrorState, Grid, Poster, Progress, ReleaseTile, Row, Section, SkeletonGrid } from '../components/ui.tsx';
import { relativeDate, todayName } from '../format.ts';
import { Link, navigate } from '../router.ts';
import { haptic } from '../telegram.ts';
import { userData } from '../user.ts';

function ContinueWatching() {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  useEffect(() => {
    userData()
      .history()
      .then(setItems)
      .catch(() => setItems([]));
  }, []);
  if (!items?.length) return null;
  return (
    <Section title="Продолжить просмотр">
      <Row>
        {items.slice(0, 12).map((item) => (
          <Link key={item.release.id} to={watchPath(item.release.id, item.ordinal)} className="tile tile-wide">
            <Poster src={item.release.poster} alt={item.release.title}>
              <Progress value={item.duration ? item.time / item.duration : 0} />
            </Poster>
            <span className="tile-title">{item.release.title}</span>
            <span className="tile-note">{item.ordinal} серия</span>
          </Link>
        ))}
      </Row>
    </Section>
  );
}

function Today() {
  const { data } = useFetch<ScheduleDay[]>('/api/schedule');
  const today = data?.find((day) => day.title.toLowerCase() === todayName());
  if (!today?.items.length) return null;
  return (
    <Section
      title="Сегодня выходят"
      action={
        <Link to="/schedule" className="section-link">
          Расписание
        </Link>
      }
    >
      <Row>
        {today.items.map((item) => (
          <ReleaseTile key={item.release.id} card={item.release} note={item.nextEpisode ? `${item.nextEpisode} серия` : null} />
        ))}
      </Row>
    </Section>
  );
}

export function HomePage({ appName }: { appName: string }) {
  const latest = useFetch<ReleaseCard[]>('/api/latest?limit=24', 2 * 60_000);
  const [rolling, setRolling] = useState(false);

  const random = async () => {
    setRolling(true);
    haptic('medium');
    try {
      const card = await api<ReleaseCard>('/api/random');
      navigate(releasePath(card.alias || card.id));
    } catch {
      haptic('error');
    } finally {
      setRolling(false);
    }
  };

  return (
    <div className="page">
      <header className="home-head">
        <h1 className="logo">{appName}</h1>
        <button className="icon-btn" onClick={random} disabled={rolling} aria-label="Случайное аниме" title="Случайное аниме">
          <Icon name="dice" />
        </button>
      </header>

      <Link to="/catalog?focus=1" className="search-fake">
        <Icon name="search" size={20} />
        <span>Найти аниме</span>
      </Link>

      <ContinueWatching />
      <Today />

      <Section title="Новые серии">
        {latest.error && <ErrorState error={latest.error} onRetry={latest.reload} />}
        {latest.loading && <SkeletonGrid />}
        {latest.data && latest.data.length === 0 && <Empty>Пока пусто</Empty>}
        {latest.data && (
          <Grid>
            {latest.data.map((card) => (
              <ReleaseTile key={card.id} card={card} note={relativeDate(card.freshAt)} />
            ))}
          </Grid>
        )}
      </Section>
    </div>
  );
}
