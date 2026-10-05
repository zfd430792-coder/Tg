import { useEffect, useRef, useState } from 'react';
import type { Page, References, ReleaseCard } from '../../../shared/types.ts';
import { useFetch } from '../api.ts';
import { Icon } from '../components/icons.tsx';
import { Empty, ErrorState, Grid, ReleaseTile, Sentinel, Sheet, SkeletonGrid, Spinner } from '../components/ui.tsx';
import { plural } from '../format.ts';
import { setQuery, useLocation } from '../router.ts';
import { haptic } from '../telegram.ts';

const FILTER_KEYS = ['q', 'genres', 'types', 'from', 'to', 'status', 'sort'] as const;

// Сколько страниц было подгружено для каждого набора фильтров — чтобы при
// возврате назад список был той же длины и прокрутка встала на место.
const loadedPages = new Map<string, number>();

function filterKey(query: URLSearchParams): string {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = query.get(key);
    if (value) params.set(key, value);
  }
  return params.toString();
}

function pageUrl(key: string, page: number) {
  return `/api/catalog?${key}${key ? '&' : ''}page=${page}`;
}

function Chunk({ filters, page, last, onMore }: { filters: string; page: number; last: boolean; onMore: () => void }) {
  const { data, error, loading, reload } = useFetch<Page<ReleaseCard>>(pageUrl(filters, page));
  if (loading) return page === 1 ? <SkeletonGrid count={12} /> : <Spinner />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;
  if (page === 1 && data.items.length === 0) return <Empty emoji="🔍">Ничего не нашлось. Попробуйте убрать часть фильтров.</Empty>;
  return (
    <>
      <Grid>
        {data.items.map((card) => (
          <ReleaseTile key={card.id} card={card} />
        ))}
      </Grid>
      {last && page < data.totalPages && <Sentinel onVisible={onMore} />}
    </>
  );
}

function toggleList(list: string | null, value: string): string {
  const items = new Set((list ?? '').split(',').filter(Boolean));
  if (items.has(value)) items.delete(value);
  else items.add(value);
  return [...items].join(',');
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      className={`chip ${active ? 'active' : ''}`}
      onClick={() => {
        haptic('select');
        onClick();
      }}
    >
      {children}
    </button>
  );
}

export function CatalogPage() {
  const { query } = useLocation();
  const refs = useFetch<References>('/api/references', 3600_000);
  const filters = filterKey(query);
  const [pages, setPages] = useState(() => loadedPages.get(filters) ?? 1);
  const [text, setText] = useState(query.get('q') ?? '');
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const first = useFetch<Page<ReleaseCard>>(pageUrl(filters, 1));

  useEffect(() => setPages(loadedPages.get(filters) ?? 1), [filters]);

  useEffect(() => {
    if (query.get('focus')) {
      input.current?.focus();
      setQuery({ focus: null });
    }
  }, [query]);

  // Поиск по мере ввода, но не на каждую букву.
  useEffect(() => {
    const value = text.trim();
    if (value === (query.get('q') ?? '')) return;
    const timer = window.setTimeout(() => setQuery({ q: value || null }), 400);
    return () => window.clearTimeout(timer);
  }, [text, query]);

  const more = () => {
    const next = pages + 1;
    loadedPages.set(filters, next);
    setPages(next);
  };

  const genres = query.get('genres');
  const types = query.get('types');
  const status = query.get('status');
  const sort = query.get('sort') ?? 'FRESH_AT_DESC';
  const activeCount = [genres, types, status, query.get('from') || query.get('to')].filter(Boolean).length;
  const genreNames = new Map(refs.data?.genres.map((g) => [String(g.id), g.name]));
  const sortLabel = refs.data?.sorting.find((s) => s.value === sort)?.label ?? 'Сортировка';
  const total = first.data?.total;

  return (
    <div className="page">
      <div className="search-box">
        <Icon name="search" size={20} />
        <input
          ref={input}
          type="search"
          placeholder="Название аниме"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          enterKeyHint="search"
        />
        {text && (
          <button className="icon-btn" onClick={() => setText('')} aria-label="Очистить">
            <Icon name="close" size={18} />
          </button>
        )}
      </div>

      <div className="filter-bar">
        <button className={`chip ${activeCount ? 'active' : ''}`} onClick={() => setOpen(true)}>
          <Icon name="filter" size={16} /> Фильтры{activeCount ? ` · ${activeCount}` : ''}
        </button>
        <button className="chip" onClick={() => setOpen(true)}>
          <Icon name="sort" size={16} /> {sortLabel}
        </button>
        {genres?.split(',').map((id) => (
          <button key={id} className="chip active" onClick={() => setQuery({ genres: toggleList(genres, id) || null })}>
            {genreNames.get(id) ?? `Жанр ${id}`} ✕
          </button>
        ))}
      </div>

      {total !== undefined && (
        <p className="hint">
          {total} {plural(total, 'тайтл', 'тайтла', 'тайтлов')}
        </p>
      )}

      {Array.from({ length: pages }, (_, i) => (
        <Chunk key={`${filters}:${i + 1}`} filters={filters} page={i + 1} last={i + 1 === pages} onMore={more} />
      ))}

      <Sheet title="Фильтры" open={open} onClose={() => setOpen(false)}>
        {refs.loading && <Spinner />}
        {refs.error && <ErrorState error={refs.error} onRetry={refs.reload} />}
        {refs.data && (
          <>
            <h4>Статус</h4>
            <div className="chips">
              <Chip active={!status} onClick={() => setQuery({ status: null })}>
                Все
              </Chip>
              <Chip active={status === 'ongoing'} onClick={() => setQuery({ status: 'ongoing' })}>
                Выходят
              </Chip>
              <Chip active={status === 'finished'} onClick={() => setQuery({ status: 'finished' })}>
                Завершённые
              </Chip>
            </div>

            <h4>Сортировка</h4>
            <div className="chips">
              {refs.data.sorting.map((s) => (
                <Chip key={s.value} active={sort === s.value} onClick={() => setQuery({ sort: s.value === 'FRESH_AT_DESC' ? null : s.value })}>
                  {s.label}
                </Chip>
              ))}
            </div>

            <h4>Тип</h4>
            <div className="chips">
              {refs.data.types.map((t) => (
                <Chip key={t.value} active={Boolean(types?.split(',').includes(t.value))} onClick={() => setQuery({ types: toggleList(types, t.value) || null })}>
                  {t.label}
                </Chip>
              ))}
            </div>

            <h4>Годы</h4>
            <div className="years">
              <select value={query.get('from') ?? ''} onChange={(e) => setQuery({ from: e.target.value || null })} aria-label="С года">
                <option value="">с любого</option>
                {refs.data.years.map((y) => (
                  <option key={y} value={y}>
                    с {y}
                  </option>
                ))}
              </select>
              <select value={query.get('to') ?? ''} onChange={(e) => setQuery({ to: e.target.value || null })} aria-label="По год">
                <option value="">по любой</option>
                {refs.data.years.map((y) => (
                  <option key={y} value={y}>
                    по {y}
                  </option>
                ))}
              </select>
            </div>

            <h4>Жанры</h4>
            <div className="chips">
              {refs.data.genres.map((g) => (
                <Chip key={g.id} active={Boolean(genres?.split(',').includes(String(g.id)))} onClick={() => setQuery({ genres: toggleList(genres, String(g.id)) || null })}>
                  {g.name}
                </Chip>
              ))}
            </div>

            <div className="sheet-actions">
              <button className="btn ghost" onClick={() => setQuery({ genres: null, types: null, from: null, to: null, status: null, sort: null })}>
                Сбросить
              </button>
              <button className="btn" onClick={() => setOpen(false)}>
                Показать{total !== undefined ? ` ${total}` : ''}
              </button>
            </div>
          </>
        )}
      </Sheet>
    </div>
  );
}
