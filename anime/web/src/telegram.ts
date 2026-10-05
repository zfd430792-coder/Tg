// Обёртка над Telegram.WebApp. В обычном браузере скрипт Telegram тоже
// загружается, но initData пустая — так мы и отличаем Mini App от сайта.
// Методы появлялись в разных версиях Bot API, поэтому каждый вызов проверяем.

interface TgWebApp {
  initData: string;
  initDataUnsafe: {
    user?: { id: number; first_name: string; username?: string; photo_url?: string; allows_write_to_pm?: boolean };
    start_param?: string;
  };
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  isVersionAtLeast(version: string): boolean;
  ready(): void;
  expand(): void;
  disableVerticalSwipes?(): void;
  requestFullscreen?(): void;
  exitFullscreen?(): void;
  requestWriteAccess?(callback?: (granted: boolean) => void): void;
  openTelegramLink(url: string): void;
  openLink(url: string): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
  HapticFeedback: {
    impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
    selectionChanged(): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp };
  }
}

const webApp = window.Telegram?.WebApp;

/** Mini App открыт внутри Telegram (есть подписанные данные о пользователе). */
export const tg: TgWebApp | null = webApp && webApp.initData ? webApp : null;

export const initData = tg?.initData ?? '';

function since(version: string): boolean {
  return Boolean(tg && tg.isVersionAtLeast(version));
}

function attempt(fn: () => void): void {
  try {
    fn();
  } catch {
    // старый клиент Telegram не знает метод — просто пропускаем
  }
}

export function setupTelegram(): void {
  if (!tg) return;
  document.documentElement.classList.add('tg');
  attempt(() => tg.ready());
  attempt(() => tg.expand());
  // Иначе свайп вниз по плееру сворачивает приложение.
  if (since('7.7')) attempt(() => tg.disableVerticalSwipes?.());
  if (since('6.1')) {
    attempt(() => tg.setHeaderColor?.('bg_color'));
  }
}

export function startParam(): string | null {
  return tg?.initDataUnsafe.start_param ?? null;
}

export function haptic(kind: 'light' | 'medium' | 'success' | 'error' | 'select' = 'light'): void {
  if (!since('6.1')) return;
  attempt(() => {
    if (kind === 'success' || kind === 'error') tg!.HapticFeedback.notificationOccurred(kind);
    else if (kind === 'select') tg!.HapticFeedback.selectionChanged();
    else tg!.HapticFeedback.impactOccurred(kind);
  });
}

export function backButton(visible: boolean, onClick: () => void): () => void {
  if (!since('6.1')) return () => undefined;
  attempt(() => (visible ? tg!.BackButton.show() : tg!.BackButton.hide()));
  attempt(() => tg!.BackButton.onClick(onClick));
  return () => attempt(() => tg!.BackButton.offClick(onClick));
}

/** Просит разрешение писать пользователю — без него бот не сможет прислать уведомление. */
export function ensureWriteAccess(): Promise<boolean> {
  if (!tg) return Promise.resolve(false);
  if (tg.initDataUnsafe.user?.allows_write_to_pm) return Promise.resolve(true);
  if (!since('6.9') || !tg.requestWriteAccess) return Promise.resolve(true);
  return new Promise((resolve) => {
    try {
      tg.requestWriteAccess!((granted) => resolve(granted));
    } catch {
      resolve(true);
    }
  });
}

export function appFullscreen(on: boolean): void {
  if (!since('8.0')) return;
  attempt(() => (on ? tg!.requestFullscreen?.() : tg!.exitFullscreen?.()));
}

export function shareLink(url: string, text: string): void {
  const share = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
  if (tg) {
    tg.openTelegramLink(share);
  } else if (navigator.share) {
    navigator.share({ url, title: text }).catch(() => undefined);
  } else {
    navigator.clipboard?.writeText(url).catch(() => undefined);
    window.open(share, '_blank', 'noopener');
  }
}
