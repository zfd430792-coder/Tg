// Ссылки внутрь приложения из Telegram. Параметр startapp/start может
// содержать только A-Z, a-z, 0-9, _ и -, поэтому точку в номере серии
// (бывают серии 12.5) кодируем буквой p.

export function releasePath(idOrAlias: string | number): string {
  return `/release/${encodeURIComponent(String(idOrAlias))}`;
}

export function watchPath(idOrAlias: string | number, ordinal: number): string {
  return `/watch/${encodeURIComponent(String(idOrAlias))}/${ordinal}`;
}

export function releaseStartParam(releaseId: number): string {
  return `r_${releaseId}`;
}

export function watchStartParam(releaseId: number, ordinal: number): string {
  return `w_${releaseId}_${String(ordinal).replace('.', 'p')}`;
}

export function startParamToPath(param: string | null | undefined): string | null {
  if (!param) return null;
  const release = /^r_(\d+)$/.exec(param);
  if (release) return releasePath(release[1]);
  const watch = /^w_(\d+)_(\d+(?:p\d+)?)$/.exec(param);
  if (watch) return watchPath(watch[1], Number(watch[2].replace('p', '.')));
  return null;
}
