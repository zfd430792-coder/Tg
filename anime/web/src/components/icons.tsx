// Иконки в одном стиле (контур 24×24), чтобы не тянуть иконочный шрифт.

import type { SVGProps } from 'react';

const paths = {
  play: 'M8 5.5v13l10.5-6.5z',
  pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
  next: 'M6 6l8.5 6L6 18zM16 6h2v12h-2z',
  prev: 'M18 6l-8.5 6L18 18zM6 6h2v12H6z',
  replay10: 'M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z',
  forward10: 'M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z',
  fullscreen: 'M4 9V4h5v2H6v3zM15 4h5v5h-2V6h-3zM4 15h2v3h3v2H4zM18 15h2v5h-5v-2h3z',
  fullscreenExit: 'M9 4v5H4V7h3V4zM15 4h2v3h3v2h-5zM4 15h5v5H7v-3H4zM15 15h5v2h-3v3h-2z',
  settings:
    'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm8.4 4.6l1.8 1.4-2 3.4-2.1-.8a7.6 7.6 0 0 1-1.7 1l-.3 2.3h-4l-.3-2.3a7.6 7.6 0 0 1-1.7-1l-2.1.8-2-3.4 1.8-1.4a7.7 7.7 0 0 1 0-2l-1.8-1.4 2-3.4 2.1.8a7.6 7.6 0 0 1 1.7-1L10 2.2h4l.3 2.3a7.6 7.6 0 0 1 1.7 1l2.1-.8 2 3.4-1.8 1.4a7.7 7.7 0 0 1 0 2z',
  volume: 'M4 9h4l5-4v14l-5-4H4zM16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12',
  mute: 'M4 9h4l5-4v14l-5-4H4zM16.5 9.5l5 5M21.5 9.5l-5 5',
  pip: 'M3 5h18v14H3zM12 12h7v5h-7z',
  heart: 'M12 20s-7.5-4.6-9.3-9.2C1.5 7.6 3.6 4.5 7 4.5c2 0 3.6 1.2 5 3 1.4-1.8 3-3 5-3 3.4 0 5.5 3.1 4.3 6.3C19.5 15.4 12 20 12 20z',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
  share: 'M12 3v12M7 8l5-5 5 5M5 13v7h14v-7',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.5 15.5L20 20',
  dice: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01',
  home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20c1.5-4 4.5-5.5 8-5.5s6.5 1.5 8 5.5',
  back: 'M15 5l-7 7 7 7',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  chevron: 'M9 6l6 6-6 6',
  close: 'M6 6l12 12M18 6L6 18',
  filter: 'M4 6h16M7 12h10M10 18h4',
  sort: 'M7 4v16M3.5 16.5L7 20l3.5-3.5M17 20V4M13.5 7.5L17 4l3.5 3.5',
  skip: 'M5 6l8 6-8 6zM13 6l8 6-8 6z',
} as const;

const filled = new Set<keyof typeof paths>(['play', 'pause', 'next', 'prev']);

export type IconName = keyof typeof paths;

export function Icon({ name, size = 24, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  const fill = filled.has(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? 'currentColor' : 'none'}
      stroke={fill ? 'none' : 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={paths[name]} />
    </svg>
  );
}
