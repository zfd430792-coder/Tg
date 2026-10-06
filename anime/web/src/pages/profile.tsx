import { useEffect, useState } from 'react';
import { watchPath } from '../../../shared/links.ts';
import type { AppConfig, HistoryItem, ReleaseCard, User } from '../../../shared/types.ts';
import { Empty, ErrorState, Grid, Poster, ReleaseTile, Spinner } from '../components/ui.tsx';
import { relativeDate } from '../format.ts';
import { Link, setQuery, useLocation } from '../router.ts';
import { haptic, tg } from '../telegram.ts';
import { updateSettings, userData, useSettings } from '../user.ts';

type Tab = 'history' | 'favorites' | 'subscriptions';

function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    load()
      .then((value) => alive && setData(value))
      .catch((e: Error) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, deps);
  return { data, error };
}

function HistoryList({ items }: { items: HistoryItem[] }) {
  if (items.length === 0) return <Empty emoji="📺">Вы ещё ничего не смотрели</Empty>;
  return (
    <ul className="day-list">
      {items.map((item) => (
        <li key={item.release.id}>
          <Link to={watchPath(item.release.id, item.ordinal)} className="day-item">
            <Poster src={item.release.poster} alt={item.release.title} className="small" />
            <div>
              <b>{item.release.title}</b>
              <span className="hint">
                {item.ordinal} серия · {item.watched ? 'досмотрена' : item.duration > 0 ? `${Math.round((item.time / item.duration) * 100)}%` : 'открыта'} ·{' '}
                {relativeDate(item.updatedAt)}
              </span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Cards({ items, empty }: { items: ReleaseCard[]; empty: string }) {
  if (items.length === 0) return <Empty>{empty}</Empty>;
  return (
    <Grid>
      {items.map((card) => (
        <ReleaseTile key={card.id} card={card} />
      ))}
    </Grid>
  );
}

export function ProfilePage({ config }: { config: AppConfig }) {
  const { query } = useLocation();
  const tab = (query.get('tab') as Tab) || 'history';
  const store = userData();
  const settings = useSettings();
  const me = useLoad<User | null>(() => store.me(), [store]);
  const list = useLoad<HistoryItem[] | ReleaseCard[]>(
    () => (tab === 'favorites' ? store.favorites() : tab === 'subscriptions' ? store.subscriptions() : store.history()),
    [tab, store],
  );
  const [notify, setNotify] = useState<boolean | null>(null);
  const user = me.data;
  const tgUser = tg?.initDataUnsafe.user;

  const toggleNotify = async (on: boolean) => {
    setNotify(on);
    haptic('select');
    await store.setNotify(on).catch(() => setNotify(!on));
  };

  const tabs: [Tab, string][] = [
    ['history', 'История'],
    ['favorites', 'Избранное'],
    ...(store.mode === 'telegram' ? ([['subscriptions', 'Подписки']] as [Tab, string][]) : []),
  ];

  return (
    <div className="page">
      <div className="profile">
        {user?.photoUrl || tgUser?.photo_url ? (
          <img className="avatar" src={user?.photoUrl ?? tgUser?.photo_url} alt="" />
        ) : (
          <span className="avatar">{(user?.firstName ?? tgUser?.first_name ?? 'Г').slice(0, 1)}</span>
        )}
        <div>
          <h1>{user?.firstName ?? tgUser?.first_name ?? 'Гость'}</h1>
          <p className="hint">
            {store.mode === 'telegram'
              ? 'Прогресс и избранное синхронизируются через Telegram'
              : 'Прогресс и избранное хранятся только в этом браузере'}
          </p>
        </div>
      </div>

      {store.mode === 'local' && config.botUsername && (
        <a className="notice link" href={`https://t.me/${config.botUsername}`} target="_blank" rel="noreferrer">
          Откройте {config.appName} в Telegram — там прогресс сохранится на всех устройствах, а бот пришлёт новые серии.
        </a>
      )}

      <div className="tabs" role="tablist">
        {tabs.map(([value, label]) => (
          <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => setQuery({ tab: value === 'history' ? null : value })}>
            {label}
          </button>
        ))}
      </div>

      {list.error && <ErrorState error={list.error} />}
      {!list.data && !list.error && <Spinner />}
      {list.data && tab === 'history' && <HistoryList items={list.data as HistoryItem[]} />}
      {list.data && tab === 'favorites' && <Cards items={list.data as ReleaseCard[]} empty="Нажмите ♥ на странице тайтла, чтобы добавить его сюда" />}
      {list.data && tab === 'subscriptions' && <Cards items={list.data as ReleaseCard[]} empty="Нажмите 🔔 у онгоинга — бот пришлёт новую серию" />}

      <h2 className="settings-title">Настройки</h2>
      <div className="settings">
        {store.mode === 'telegram' && user && (
          <label className="setting">
            <span>Уведомления о новых сериях</span>
            <input type="checkbox" checked={notify ?? user.notify} onChange={(e) => toggleNotify(e.target.checked)} />
          </label>
        )}
        <label className="setting">
          <span>Пропускать опенинг автоматически</span>
          <input type="checkbox" checked={settings.autoSkip} onChange={(e) => updateSettings({ autoSkip: e.target.checked })} />
        </label>
        <label className="setting">
          <span>Включать следующую серию</span>
          <input type="checkbox" checked={settings.autoNext} onChange={(e) => updateSettings({ autoNext: e.target.checked })} />
        </label>
        <label className="setting">
          <span>Качество по умолчанию</span>
          <select
            value={String(settings.quality)}
            onChange={(e) => updateSettings({ quality: e.target.value === 'auto' ? 'auto' : Number(e.target.value) })}
          >
            <option value="auto">Авто</option>
            <option value="1080">1080p</option>
            <option value="720">720p</option>
            <option value="480">480p</option>
          </select>
        </label>
      </div>

      <p className="hint center footer-note">
        Видео и озвучка — AniLiberty. Все права на аниме принадлежат правообладателям.
      </p>
    </div>
  );
}
