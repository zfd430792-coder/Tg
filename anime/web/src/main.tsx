import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { startParamToPath } from '../../shared/links.ts';
import { getConfig } from './api.ts';
import { App } from './app.tsx';
import { navigate } from './router.ts';
import { setupTelegram, startParam } from './telegram.ts';
import { initUserData } from './user.ts';
import './styles.css';

setupTelegram();

// Ссылка вида t.me/<бот>/<app>?startapp=r_123 открывает сразу нужный тайтл,
// а под ним в истории остаётся главная — кнопка «Назад» ведёт туда.
const start = startParamToPath(startParam());
if (start && location.pathname === '/') navigate(start);

Promise.all([getConfig(), initUserData()]).then(([config]) => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App config={config} />
    </StrictMode>,
  );
});
