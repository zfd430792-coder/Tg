import { useEffect, useLayoutEffect, type ReactNode } from 'react';
import type { AppConfig } from '../../shared/types.ts';
import { Icon, type IconName } from './components/icons.tsx';
import { Empty } from './components/ui.tsx';
import { CatalogPage } from './pages/catalog.tsx';
import { HomePage } from './pages/home.tsx';
import { ProfilePage } from './pages/profile.tsx';
import { ReleasePage } from './pages/release.tsx';
import { SchedulePage } from './pages/schedule.tsx';
import { WatchPage } from './pages/watch.tsx';
import { Link, goBack, match, savedScroll, useLocation } from './router.ts';
import { backButton, haptic } from './telegram.ts';

const TABS: { path: string; label: string; icon: IconName }[] = [
  { path: '/', label: 'Главная', icon: 'home' },
  { path: '/catalog', label: 'Каталог', icon: 'grid' },
  { path: '/schedule', label: 'Расписание', icon: 'calendar' },
  { path: '/me', label: 'Моё', icon: 'user' },
];

function route(path: string, config: AppConfig): ReactNode {
  if (path === '/') return <HomePage appName={config.appName} />;
  if (path === '/catalog') return <CatalogPage />;
  if (path === '/schedule') return <SchedulePage />;
  if (path === '/me') return <ProfilePage config={config} />;
  let params = match('/release/:id', path);
  if (params) return <ReleasePage key={params.id} id={params.id} config={config} />;
  params = match('/watch/:id/:ordinal', path);
  if (params) return <WatchPage key={params.id} id={params.id} ordinal={params.ordinal} config={config} />;
  return <Empty emoji="🗺️">Такой страницы нет</Empty>;
}

export function App({ config }: { config: AppConfig }) {
  const location = useLocation();
  const isTab = TABS.some((tab) => tab.path === location.path);

  // Кнопка «Назад» в шапке Telegram: на вложенных страницах.
  useEffect(() => backButton(location.depth > 0 && !isTab, goBack), [location.depth, isTab]);

  useLayoutEffect(() => {
    window.scrollTo(0, location.pop ? savedScroll(location.key) : 0);
  }, [location.key, location.pop]);

  useEffect(() => {
    if (isTab) document.title = `${config.appName} — аниме с русской озвучкой`;
  }, [isTab, location.path, config.appName]);

  return (
    <>
      <main className="main">{route(location.path, config)}</main>
      <nav className="tabbar">
        {TABS.map((tab) => {
          const active = tab.path === '/' ? location.path === '/' : location.path.startsWith(tab.path);
          return (
            <Link key={tab.path} to={tab.path} replace={isTab} className={active ? 'active' : ''} onClick={() => haptic('select')}>
              <Icon name={tab.icon} size={22} />
              <span>{tab.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
