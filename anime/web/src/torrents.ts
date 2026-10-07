// Торрент-плеер на странице: какие озвучки и качества этот браузер покажет и что выбрать.
// Отдельно от player.tsx: тот грузится лениво вместе с hls.js.

import type { Dub, PlayerSource, TorrentVariant } from '../../shared/types.ts';

export { heightName, pickQuality, qualityOptions, type QualityOption } from '../../shared/torrents.ts';

const CODECS: Record<string, string> = {
  hevc: 'hvc1.1.6.L150.90',
  hevc10: 'hvc1.2.4.L153.B0',
  av1: 'av01.0.08M.08',
  av110: 'av01.0.08M.10',
};

const supported = new Map<string, boolean>();

/** Покажет ли браузер такое видео: H.264 — везде, HEVC (часто это 4K) — iPhone, Mac и не все Android. */
export function canPlayCodec(codec: string | null, tenBit = false): boolean {
  if (!codec || codec === 'h264') return true;
  const key = codec === 'hevc' || codec === 'av1' ? `${codec}${tenBit ? '10' : ''}` : null;
  if (!key) return false;
  let ok = supported.get(key);
  if (ok === undefined) {
    const type = `video/mp4; codecs="${CODECS[key]}"`;
    try {
      ok = Boolean(window.MediaSource?.isTypeSupported?.(type)) || document.createElement('video').canPlayType(type) !== '';
    } catch {
      ok = false;
    }
    supported.set(key, ok);
  }
  return ok;
}

export const playable = (v: TorrentVariant) => canPlayCodec(v.codec, v.tenBit);

/**
 * Плеер «Торрент» для этого браузера: озвучки, у которых есть видео, которое он покажет,
 * с качеством и сериями только по таким вариантам. Нечего показать и не ищем — плеера нет.
 */
export function adaptTorrentSource(player: PlayerSource): PlayerSource | null {
  const variants = (player.variants ?? []).filter(playable);
  const dubs: Dub[] = [];
  for (const dub of player.dubs) {
    const own = variants.filter((v) => v.dub === dub.id);
    if (own.length === 0) continue;
    dubs.push({ ...dub, quality: Math.max(0, ...own.map((v) => v.height ?? 0)) || null, lastEpisode: Math.max(...own.flatMap((v) => v.episodes)) });
  }
  if (dubs.length === 0 && player.status !== 'searching') return null;
  const episodes = [...new Set(variants.flatMap((v) => v.episodes))].sort((a, b) => a - b);
  return { ...player, dubs, variants, episodes, lastEpisode: episodes.length ? episodes[episodes.length - 1] : null };
}
