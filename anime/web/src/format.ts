export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export function minutes(seconds: number | null): string | null {
  if (!seconds) return null;
  return `${Math.max(1, Math.round(seconds / 60))} мин`;
}

export function episodesCount(n: number): string {
  return `${n} ${plural(n, 'серия', 'серии', 'серий')}`;
}

export function relativeDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 3600) return 'только что';
  if (diff < 86400) {
    const h = Math.floor(diff / 3600);
    return `${h} ${plural(h, 'час', 'часа', 'часов')} назад`;
  }
  if (diff < 7 * 86400) {
    const d = Math.floor(diff / 86400);
    return d === 1 ? 'вчера' : `${d} ${plural(d, 'день', 'дня', 'дней')} назад`;
  }
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

export function todayName(): string {
  return WEEKDAYS[new Date().getDay()];
}
