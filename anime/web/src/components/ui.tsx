import { useEffect, useRef, type ReactNode } from 'react';
import { releasePath } from '../../../shared/links.ts';
import type { ReleaseCard } from '../../../shared/types.ts';
import type { ApiError } from '../api.ts';
import { Link, goBack } from '../router.ts';
import { Icon } from './icons.tsx';

export function Progress({ value }: { value: number }) {
  return (
    <span className="tile-progress">
      <span style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }} />
    </span>
  );
}

export function Poster({ src, alt, className = '', children }: { src: string | null; alt: string; className?: string; children?: ReactNode }) {
  return (
    <div className={`poster ${className}`}>
      {src ? <img src={src} alt={alt} loading="lazy" decoding="async" /> : <span className="poster-empty">{alt.slice(0, 1)}</span>}
      {children}
    </div>
  );
}

export function ReleaseTile({ card, note, progress }: { card: ReleaseCard; note?: string | null; progress?: number }) {
  return (
    <Link to={releasePath(card.alias || card.id)} className="tile">
      <Poster src={card.poster} alt={card.title}>
        {card.isOngoing && <span className="badge">онгоинг</span>}
        {progress !== undefined && <Progress value={progress} />}
      </Poster>
      <span className="tile-title">{card.title}</span>
      <span className="tile-note">{note ?? [card.year, card.type].filter(Boolean).join(' · ')}</span>
    </Link>
  );
}

export function Grid({ children }: { children: ReactNode }) {
  return <div className="grid">{children}</div>;
}

export function Row({ children }: { children: ReactNode }) {
  return <div className="row-scroll">{children}</div>;
}

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Spinner({ label = 'Загрузка…' }: { label?: string }) {
  return (
    <div className="state" role="status">
      <span className="spinner" />
      <span>{label}</span>
    </div>
  );
}

export function SkeletonGrid({ count = 9 }: { count?: number }) {
  return (
    <div className="grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="tile skeleton">
          <div className="poster" />
          <span className="tile-title" />
        </div>
      ))}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: ApiError | Error; onRetry?: () => void }) {
  return (
    <div className="state">
      <span className="state-emoji">😵</span>
      <span>{error.message || 'Что-то пошло не так'}</span>
      {onRetry && (
        <button className="btn" onClick={onRetry}>
          Повторить
        </button>
      )}
    </div>
  );
}

export function Empty({ emoji = '🌸', children }: { emoji?: string; children: ReactNode }) {
  return (
    <div className="state">
      <span className="state-emoji">{emoji}</span>
      <span>{children}</span>
    </div>
  );
}

export function BackLink() {
  return (
    <button className="icon-btn back-link" onClick={goBack} aria-label="Назад">
      <Icon name="back" />
    </button>
  );
}

/** Нижняя шторка для фильтров и меню. */
export function Sheet({ title, open, onClose, children }: { title: string; open: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.classList.add('locked');
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('locked');
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={title} tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <Icon name="close" />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

/** Вызывает onVisible, когда элемент доезжает до экрана — для подгрузки списка. */
export function Sentinel({ onVisible }: { onVisible: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const callback = useRef(onVisible);
  callback.current = onVisible;
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => entries[0]?.isIntersecting && callback.current(), { rootMargin: '600px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <div ref={ref} className="sentinel" />;
}
