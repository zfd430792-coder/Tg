// Студии озвучки аниме: одна студия в разных раздачах подписана по-разному («DreamCast»,
// «Dream Cast», «[Dream Cast] MVO»), а зрителям нужны популярные — их и показываем первыми.
// Порядок списка — порядок кнопок на странице.

import { normalizeName } from './titles.ts';

const STUDIOS: { name: string; aliases: string[] }[] = [
  { name: 'Dream Cast', aliases: ['dream cast', 'dreamcast', 'dreamers cast', 'dreamerscast'] },
  { name: 'AniDub', aliases: ['anidub', 'ani dub'] },
  { name: 'Studio Band', aliases: ['studio band', 'studioband', 'студийная банда'] },
  { name: 'AniLibria', aliases: ['anilibria', 'ani libria', 'анилибрия'] },
  { name: 'SHIZA Project', aliases: ['shiza project', 'shiza', 'шиза'] },
  { name: 'AniMedia', aliases: ['animedia', 'ani media'] },
  { name: 'JAM CLUB', aliases: ['jam club', 'jamclub', 'jam'] },
  { name: 'AnimeVost', aliases: ['animevost', 'anime vost'] },
  { name: 'Persona99', aliases: ['persona99', 'persona 99'] },
  { name: 'Jaskier', aliases: ['jaskier'] },
  { name: 'SovetRomantica', aliases: ['sovetromantica', 'sovet romantica'] },
  { name: 'AniStar', aliases: ['anistar', 'ani star'] },
  { name: 'Amber', aliases: ['amber'] },
  { name: 'AniMaunt', aliases: ['animaunt', 'ani maunt'] },
  { name: 'Onibaku', aliases: ['onibaku'] },
  { name: 'Kansai', aliases: ['kansai studio', 'kansai'] },
  { name: 'Anything Group', aliases: ['anything group', 'anything-group'] },
  { name: 'Reanimedia', aliases: ['reanimedia'] },
  { name: 'Wakanim', aliases: ['wakanim'] },
  { name: 'Crunchyroll', aliases: ['crunchyroll'] },
  { name: 'AniFilm', aliases: ['anifilm', 'ani film'] },
  { name: 'Animereactor', aliases: ['animereactor', 'anime reactor'] },
  { name: 'AniPLague', aliases: ['aniplague'] },
  { name: 'Akari Group', aliases: ['akari group', 'akari'] },
];

const INDEX = STUDIOS.flatMap((studio, order) => studio.aliases.map((alias) => ({ studio: studio.name, order, alias: normalizeName(alias) })))
  // Сначала длинные: «jam club» раньше «jam».
  .sort((a, b) => b.alias.length - a.alias.length);

/** Известная студия в подписи дорожки или названии папки: «MVO | DreamCast» → «Dream Cast». */
export function knownStudio(label: string): { name: string; order: number } | null {
  const text = ` ${normalizeName(label)} `;
  const squeezed = text.replace(/ /g, '');
  for (const { studio, order, alias } of INDEX) {
    if (text.includes(` ${alias} `) || (alias.length >= 6 && squeezed.includes(alias.replace(/ /g, '')))) return { name: studio, order };
  }
  return null;
}

/** Какие известные студии упомянуты в тексте (названии раздачи, списке озвучек с трекера). */
export function studiosIn(texts: string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    // «| AniLibria, AniDub, Dream Cast» — перечисление через запятую или «/».
    for (const part of text.split(/[|,/;+&()[\]]+/)) {
      const studio = knownStudio(part);
      if (studio) found.add(studio.name);
    }
  }
  return [...found];
}

/** Место студии в списке популярных (меньше — раньше); неизвестные — после них. */
export function studioOrder(name: string): number {
  return knownStudio(name)?.order ?? STUDIOS.length;
}
