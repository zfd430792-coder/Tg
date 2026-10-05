import { releasePath } from '../../../shared/links.ts';
import type { ScheduleDay } from '../../../shared/types.ts';
import { useFetch } from '../api.ts';
import { Empty, ErrorState, Poster, Spinner } from '../components/ui.tsx';
import { todayName } from '../format.ts';
import { Link } from '../router.ts';

export function SchedulePage() {
  const { data, error, loading, reload } = useFetch<ScheduleDay[]>('/api/schedule');
  if (loading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data?.length) return <Empty>Расписание пока пустое</Empty>;

  // Начинаем неделю с сегодняшнего дня — его смотрят чаще всего.
  const today = data.findIndex((day) => day.title.toLowerCase() === todayName());
  const days = today > 0 ? [...data.slice(today), ...data.slice(0, today)] : data;

  return (
    <div className="page">
      <h1 className="page-title">Расписание</h1>
      <p className="hint">Когда выходят новые серии онгоингов с озвучкой.</p>
      {days.map((day) => {
        const isToday = day.title.toLowerCase() === todayName();
        return (
          <section key={day.day} className={`day ${isToday ? 'today' : ''}`}>
            <h2>
              {day.title}
              {isToday && <span className="badge inline">сегодня</span>}
            </h2>
            <ul className="day-list">
              {day.items.map((item) => (
                <li key={item.release.id}>
                  <Link to={releasePath(item.release.alias || item.release.id)} className="day-item">
                    <Poster src={item.release.poster} alt={item.release.title} className="small" />
                    <div>
                      <b>{item.release.title}</b>
                      <span className="hint">
                        {item.lastEpisode ? `вышла ${item.lastEpisode} серия` : 'скоро первая серия'}
                        {item.nextEpisode ? ` · дальше ${item.nextEpisode}` : ''}
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
