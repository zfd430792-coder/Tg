// Торрент-плеер: какое качество включить. Общее для сайта и тестов сервера.

import type { TorrentVariant } from './types.ts';

export interface QualityOption {
  height: number;
  variant: TorrentVariant;
}

/** Качества этой озвучки для серии: по лучшему варианту на высоту кадра (без перекодирования, больше раздающих). */
export function qualityOptions(variants: TorrentVariant[], dub: string | null, ordinal: number): QualityOption[] {
  const best = new Map<number, TorrentVariant>();
  for (const v of variants) {
    if (v.dub !== dub || !v.episodes.includes(ordinal)) continue;
    const height = v.height ?? 0;
    const current = best.get(height);
    if (!current || Number(current.transcode) - Number(v.transcode) > 0 || (current.transcode === v.transcode && v.seeders > current.seeders)) best.set(height, v);
  }
  return [...best.entries()].sort((a, b) => b[0] - a[0]).map(([height, variant]) => ({ height, variant }));
}

/** Какое качество включить: выбранное в настройках (или ближайшее), «Авто» — 1080p, иначе лучшее до него. */
export function pickQuality(options: QualityOption[], wanted: 'auto' | number): QualityOption | null {
  if (options.length === 0) return null;
  const target = wanted === 'auto' ? 1080 : wanted;
  const exact = options.find((o) => o.height === target);
  if (exact) return exact;
  if (wanted === 'auto') return options.find((o) => o.height < target) ?? options[options.length - 1];
  return [...options].sort((a, b) => Math.abs(a.height - target) - Math.abs(b.height - target) || a.height - b.height)[0];
}

/** «4K», «1080p»; без высоты — «SD». */
export function heightName(height: number | null): string {
  if (!height) return 'SD';
  return height >= 2000 ? '4K' : `${height}p`;
}
