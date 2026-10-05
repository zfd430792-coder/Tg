#!/usr/bin/env bash
# Автообновление AniMini с GitHub. Запускается таймером (systemd или cron)
# и вручную: sudo animini update [--force].
#
# Если в ветке появился новый коммит — забирает его, пересобирает контейнер
# и проверяет, что приложение ответило. Не ответило — откатывает на прошлую
# рабочую версию и больше не пробует этот коммит, пока не выйдет следующий.

# Всё в функции: git reset перезапишет этот файл прямо во время работы,
# а bash к тому моменту уже прочитал функцию целиком.
main() {
  set -Eeuo pipefail
  local conf=${ANIMINI_CONF:-/etc/animini.conf} force=0
  [[ "${1:-}" == "--force" ]] && force=1
  [[ -r "$conf" ]] || { echo "Нет $conf — сначала запустите install.sh" >&2; exit 1; }
  local REPO BRANCH DIR STATE
  REPO=$(sed -n 's/^REPO=//p' "$conf")
  BRANCH=$(sed -n 's/^BRANCH=//p' "$conf")
  DIR=$(sed -n 's/^DIR=//p' "$conf")
  STATE=$(sed -n 's/^STATE=//p' "$conf")
  local app="$DIR/anime"

  log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }

  mkdir -p "$STATE"
  exec 9>"$STATE/update.lock"
  flock -n 9 || { log "обновление уже идёт"; exit 0; }

  git -C "$DIR" remote set-url origin "$REPO"
  git -C "$DIR" fetch --quiet --depth 1 origin "$BRANCH"
  local remote deployed failed
  remote=$(git -C "$DIR" rev-parse FETCH_HEAD)
  deployed=$(cat "$STATE/deployed" 2>/dev/null || true)
  failed=$(cat "$STATE/failed" 2>/dev/null || true)

  if ((force == 0)); then
    [[ "$remote" != "$deployed" ]] || exit 0
    if [[ "$remote" == "$failed" ]]; then
      log "версия ${remote:0:7} уже не собралась, жду следующий коммит"
      exit 0
    fi
  fi

  log "обновляю ${deployed:0:7} → ${remote:0:7}: $(git -C "$DIR" log -1 --format=%s "$remote")"
  git -C "$DIR" reset --quiet --hard "$remote"

  # Caddyfile примонтирован файлом: после git reset контейнер видит старую копию,
  # поэтому при его изменении Caddy пересоздаём.
  local recreate=()
  if [[ -n "$deployed" ]] && ! grep -q 'docker-compose.external.yml' "$app/.env" 2>/dev/null &&
    ! git -C "$DIR" diff --quiet "$deployed" "$remote" -- anime/Caddyfile 2>/dev/null; then
    recreate=(--force-recreate caddy)
    log "изменился Caddyfile — перезапущу Caddy"
  fi

  if (cd "$app" && docker compose build --pull app && docker compose up -d --remove-orphans &&
    { ((${#recreate[@]} == 0)) || docker compose up -d "${recreate[@]}"; }) && healthy "$app"; then
    echo "$remote" >"$STATE/deployed"
    rm -f "$STATE/failed"
    docker image prune -f >/dev/null 2>&1 || true
    log "готово, работает ${remote:0:7}"
    exit 0
  fi

  echo "$remote" >"$STATE/failed"
  if [[ -n "$deployed" ]]; then
    log "новая версия не запустилась — откатываю на ${deployed:0:7}"
    git -C "$DIR" reset --quiet --hard "$deployed"
    (cd "$app" && docker compose up -d --build --remove-orphans) || true
    if healthy "$app"; then
      log "откат удался"
    else
      log "после отката приложение тоже не отвечает — смотрите: animini logs"
    fi
  fi
  exit 1
}

# Приложение отвечает на /api/health изнутри контейнера.
healthy() {
  local app=$1 i
  for ((i = 0; i < 40; i++)); do
    (cd "$app" && docker compose exec -T app wget -qO- http://127.0.0.1:3000/api/health) >/dev/null 2>&1 && return 0
    sleep 3
  done
  return 1
}

# main всегда заканчивается exit, так что изменённый git reset файл bash дальше не читает.
main "$@"
