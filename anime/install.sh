#!/usr/bin/env bash
# Установка AniMini на VPS одной командой:
#
#   curl -fsSL https://raw.githubusercontent.com/zfd430792-coder/Tg/anime-mini-app/anime/install.sh | sudo bash
#
# Скрипт ставит Docker, спрашивает токен бота и домен, поднимает приложение
# с HTTPS (Caddy) и включает автообновление с GitHub. Повторный запуск —
# это смена настроек: текущие значения подставятся по умолчанию.
#
# Всё можно передать заранее, тогда вопросов не будет:
#   BOT_TOKEN=... DOMAIN=anime.example.com curl -fsSL .../install.sh | sudo -E bash
set -Eeuo pipefail

REPO="${ANIMINI_REPO:-https://github.com/zfd430792-coder/Tg.git}"
BRANCH="${ANIMINI_BRANCH:-anime-mini-app}"
DIR="${ANIMINI_DIR:-/opt/animini}"
CONF="${ANIMINI_CONF:-/etc/animini.conf}"
STATE="${ANIMINI_STATE:-/var/lib/animini}"
BIN_DIR="${ANIMINI_BIN_DIR:-/usr/local/bin}"
SYSTEMD_DIR="${ANIMINI_SYSTEMD_DIR:-/etc/systemd/system}"
APP="$DIR/anime"

say() { printf '\n\033[1;35m▸ %s\033[0m\n' "$*" >&2; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*" >&2; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*" >&2; }
die() {
  printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2
  exit 1
}

# ---- Ввод с клавиатуры ----
# При «curl | bash» stdin занят самим скриптом, поэтому вопросы читаем из терминала.

open_input() {
  if [[ -n "${ANIMINI_INPUT:-}" ]]; then
    exec 3<"$ANIMINI_INPUT"
  elif ! { exec 3</dev/tty; } 2>/dev/null; then
    exec 3</dev/null
    INTERACTIVE=0
    return
  fi
  INTERACTIVE=1
}

ask() {
  local prompt=$1 default=${2:-} answer=''
  if [[ -n "$default" ]]; then printf '  %s [%s]: ' "$prompt" "$default" >&2; else printf '  %s: ' "$prompt" >&2; fi
  IFS= read -r -u 3 answer || true
  [[ $INTERACTIVE == 1 && -z "${ANIMINI_INPUT:-}" ]] || printf '%s\n' "${answer:-$default}" >&2
  printf '%s' "${answer:-$default}"
}

ask_secret() {
  local prompt=$1 answer=''
  printf '  %s: ' "$prompt" >&2
  if [[ $INTERACTIVE == 1 && -z "${ANIMINI_INPUT:-}" ]]; then
    IFS= read -r -s -u 3 answer || true
    printf '\n' >&2
  else
    IFS= read -r -u 3 answer || true
    printf '***\n' >&2
  fi
  printf '%s' "$answer"
}

confirm() {
  local answer
  answer=$(ask "$1 (y/n)" "$2")
  [[ "$answer" =~ ^[YyДд] ]]
}

# Значение из .env без выполнения файла как скрипта.
env_get() {
  local key=$1 file=$2
  [[ -f "$file" ]] || return 0
  sed -n "s/^${key}=//p" "$file" | tail -n 1
}

# ---- Система ----

install_packages() {
  if command -v apt-get >/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null
  elif command -v dnf >/dev/null; then
    dnf install -y -q "$@" >/dev/null
  elif command -v yum >/dev/null; then
    yum install -y -q "$@" >/dev/null
  else
    die "Не знаю, как поставить пакеты ($*) на этой системе. Нужен Ubuntu/Debian или CentOS/Fedora."
  fi
}

prepare_system() {
  say "Готовлю сервер"
  local missing=()
  for cmd in git curl; do command -v "$cmd" >/dev/null || missing+=("$cmd"); done
  if ((${#missing[@]})); then
    install_packages "${missing[@]}" ca-certificates
  fi
  ok "git и curl есть"

  if ! docker compose version >/dev/null 2>&1; then
    say "Ставлю Docker (официальный скрипт get.docker.com)"
    curl -fsSL https://get.docker.com | sh >/dev/null
    command -v systemctl >/dev/null && systemctl enable --now docker >/dev/null 2>&1 || true
    docker compose version >/dev/null 2>&1 || die "Docker не установился — посмотрите вывод выше"
  fi
  ok "$(docker compose version | head -n 1)"

  # Сборка фронтенда на VPS с 512 МБ–1 ГБ памяти без подкачки может упасть.
  local mem swap
  mem=$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo 2>/dev/null || echo 4096)
  swap=$(awk 'NR > 1' /proc/swaps 2>/dev/null | wc -l)
  if ((mem < 1500 && swap == 0)) && [[ -z "${ANIMINI_NO_SWAP:-}" ]]; then
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
    ok "памяти ${mem} МБ — добавил подкачку 2 ГБ"
  fi
}

public_ip() {
  curl -4 -fsS --max-time 6 https://api.ipify.org 2>/dev/null ||
    curl -4 -fsS --max-time 6 https://ifconfig.me 2>/dev/null ||
    hostname -I 2>/dev/null | awk '{print $1}'
}

# ---- Вопросы ----

ask_bot_token() {
  local current token me tries=0
  current=$(env_get BOT_TOKEN "$APP/.env")
  token=${BOT_TOKEN:-}
  while true; do
    ((tries++ < 5)) || die "Токен так и не подошёл. Запустите установку ещё раз."
    if [[ -z "$token" ]]; then
      if [[ -n "$current" ]]; then
        printf '  Сейчас стоит токен …%s. Enter — оставить его.\n' "${current: -6}" >&2
      else
        printf '  Создайте бота в @BotFather командой /newbot и вставьте токен.\n' >&2
      fi
      token=$(ask_secret "Токен бота")
      token=${token:-$current}
    fi
    token=$(printf '%s' "$token" | tr -d '[:space:]')
    if [[ ! "$token" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]]; then
      warn "Это не похоже на токен (вида 123456789:AA…)."
      [[ $INTERACTIVE == 1 || -n "${ANIMINI_INPUT:-}" ]] || die "Передайте BOT_TOKEN"
      token=''
      continue
    fi
    if me=$(curl -fsS --max-time 10 "https://api.telegram.org/bot${token}/getMe" 2>/dev/null); then
      BOT_USERNAME=$(printf '%s' "$me" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')
      ok "бот @${BOT_USERNAME}"
      BOT_TOKEN=$token
      return
    fi
    if curl -fsS --max-time 10 -o /dev/null https://api.telegram.org 2>/dev/null; then
      warn "Telegram не принял токен — проверьте, что скопировали его целиком."
      [[ $INTERACTIVE == 1 || -n "${ANIMINI_INPUT:-}" ]] || die "Неверный BOT_TOKEN"
      token=''
      continue
    fi
    warn "api.telegram.org недоступен с сервера — проверить токен не получилось."
    if confirm "Продолжить с этим токеном?" "y"; then
      BOT_TOKEN=$token
      BOT_USERNAME=''
      return
    fi
    token=''
  done
}

ask_domain() {
  local current default ip resolved
  ip=$(public_ip || true)
  current=$(env_get DOMAIN "$APP/.env")
  default=${current:-${ip:+${ip//./-}.sslip.io}}
  DOMAIN=${DOMAIN:-}
  if [[ -z "$DOMAIN" ]]; then
    printf '  Mini App работает только по HTTPS, поэтому нужен домен с A-записью на IP сервера (%s).\n' "${ip:-?}" >&2
    printf '  Нет домена — оставьте предложенный адрес *.sslip.io: он сам указывает на этот сервер.\n' >&2
    DOMAIN=$(ask "Домен" "$default")
  fi
  DOMAIN=$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]' | sed -E 's#^https?://##; s#/.*$##')
  [[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || die "«$DOMAIN» не похоже на домен"

  resolved=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)
  if [[ -n "$ip" && " $resolved " != *" $ip "* ]]; then
    warn "Домен $DOMAIN сейчас указывает на «${resolved:-никуда}», а IP сервера — $ip."
    warn "Пока DNS не исправлен, HTTPS-сертификат не выпустится (Caddy будет пробовать сам)."
    confirm "Всё равно продолжить?" "y" || die "Исправьте A-запись домена и запустите установку ещё раз"
  else
    ok "домен $DOMAIN → $ip"
  fi
}

ask_options() {
  local current
  current=$(env_get APP_NAME "$APP/.env")
  APP_NAME=${APP_NAME:-$(ask "Название приложения" "${current:-AniMini}")}
  APP_NAME=$(printf '%s' "$APP_NAME" | tr -d '$"\\\n')

  current=$(env_get BOT_APP_SHORT_NAME "$APP/.env")
  if [[ -z "${BOT_APP_SHORT_NAME+x}" ]]; then
    printf '  Короткое имя Mini App из @BotFather (/newapp) — для ссылок t.me/бот/имя. Можно пропустить.\n' >&2
    BOT_APP_SHORT_NAME=$(ask "Короткое имя Mini App" "$current")
  fi
  BOT_APP_SHORT_NAME=$(printf '%s' "$BOT_APP_SHORT_NAME" | tr -cd 'A-Za-z0-9_')

  current=$(env_get HLS_PROXY "$APP/.env")
  if [[ -z "${HLS_PROXY:-}" ]]; then
    printf '  Прокси видео гонит весь видеотрафик через ваш сервер. Нужен, только если у зрителей не грузится видео.\n' >&2
    if confirm "Включить прокси видео?" "$([[ $current == 1 ]] && echo y || echo n)"; then HLS_PROXY=1; else HLS_PROXY=0; fi
  fi

  if [[ -z "${AUTO_UPDATE:-}" ]]; then
    if confirm "Обновляться автоматически с GitHub (ветка $BRANCH)?" "y"; then AUTO_UPDATE=1; else AUTO_UPDATE=0; fi
  fi
  UPDATE_EVERY=${UPDATE_EVERY:-5}
}

# ---- Код и настройки ----

fetch_code() {
  say "Скачиваю код ($REPO, ветка $BRANCH)"
  if [[ -d "$DIR/.git" ]]; then
    git -C "$DIR" remote set-url origin "$REPO"
    git -C "$DIR" fetch --quiet --depth 1 origin "$BRANCH"
    git -C "$DIR" reset --quiet --hard FETCH_HEAD
  elif [[ -e "$DIR" && -n "$(ls -A "$DIR" 2>/dev/null)" ]]; then
    die "$DIR уже существует и это не установка AniMini. Удалите папку или задайте ANIMINI_DIR."
  else
    git clone --quiet --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
  fi
  [[ -f "$APP/docker-compose.yml" ]] || die "В ветке $BRANCH нет папки anime/ с приложением"
  ok "версия $(git -C "$DIR" rev-parse --short HEAD)"
}

write_config() {
  say "Сохраняю настройки"
  local old_interval
  old_interval=$(env_get NOTIFY_INTERVAL_MIN "$APP/.env")
  umask 077
  cat >"$APP/.env" <<EOF
# Создано install.sh $(date '+%Y-%m-%d %H:%M'). Поменять: sudo animini config
APP_NAME=$APP_NAME
DOMAIN=$DOMAIN
SITE_URL=https://$DOMAIN
BOT_TOKEN=$BOT_TOKEN
BOT_APP_SHORT_NAME=$BOT_APP_SHORT_NAME
HLS_PROXY=$HLS_PROXY
NOTIFY_INTERVAL_MIN=${old_interval:-10}
EOF
  cat >"$CONF" <<EOF
REPO=$REPO
BRANCH=$BRANCH
DIR=$DIR
STATE=$STATE
EOF
  umask 022
  mkdir -p "$STATE"
  ok "$APP/.env (доступ только root)"
}

start_app() {
  say "Собираю и запускаю (первый раз — пара минут)"
  (cd "$APP" && docker compose up -d --build --remove-orphans) >&2
  local i
  for ((i = 0; i < 60; i++)); do
    if (cd "$APP" && docker compose exec -T app wget -qO- http://127.0.0.1:3000/api/health) >/dev/null 2>&1; then
      git -C "$DIR" rev-parse HEAD >"$STATE/deployed"
      rm -f "$STATE/failed"
      ok "приложение работает"
      break
    fi
    sleep 3
  done
  ((i < 60)) || die "Приложение не запустилось. Логи: cd $APP && docker compose logs app"

  for ((i = 0; i < 20; i++)); do
    if curl -fsS --max-time 8 "https://$DOMAIN/api/health" >/dev/null 2>&1; then
      ok "https://$DOMAIN открывается"
      return
    fi
    sleep 4
  done
  warn "https://$DOMAIN пока не открывается. Обычно это DNS или закрытые порты 80/443 — Caddy допишет сертификат сам, как только домен заработает."
}

open_firewall() {
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
    ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ufw allow 443/udp >/dev/null
    ok "открыл порты 80 и 443 в ufw"
  fi
  local busy
  busy=$(ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null | grep -v docker-proxy || true)
  [[ -z "$busy" ]] || warn "Порты 80/443 занимает другая программа (nginx/apache?) — Caddy не сможет запуститься:"$'\n'"$busy"
}

install_tools() {
  chmod +x "$APP/deploy/update.sh" "$APP/deploy/animini"
  mkdir -p "$BIN_DIR"
  ln -sf "$APP/deploy/animini" "$BIN_DIR/animini"
  ok "команда animini"

  if [[ $AUTO_UPDATE != 1 ]]; then
    if [[ -d /run/systemd/system || -n "${ANIMINI_SYSTEMD_DIR:-}" ]] && command -v systemctl >/dev/null; then
      systemctl disable --now animini-update.timer >/dev/null 2>&1 || true
    fi
    rm -f /etc/cron.d/animini
    ok "автообновление выключено (обновить вручную: sudo animini update)"
    return
  fi

  if [[ -d /run/systemd/system || -n "${ANIMINI_SYSTEMD_DIR:-}" ]] && command -v systemctl >/dev/null; then
    cat >"$SYSTEMD_DIR/animini-update.service" <<EOF
[Unit]
Description=AniMini: обновление с GitHub
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$APP/deploy/update.sh
EOF
    cat >"$SYSTEMD_DIR/animini-update.timer" <<EOF
[Unit]
Description=AniMini: проверять обновления каждые $UPDATE_EVERY минут

[Timer]
OnBootSec=3min
OnUnitActiveSec=${UPDATE_EVERY}min
RandomizedDelaySec=30
Persistent=true

[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload
    systemctl enable --now animini-update.timer >/dev/null 2>&1
    ok "автообновление каждые $UPDATE_EVERY мин (systemd: animini-update.timer)"
  else
    echo "*/$UPDATE_EVERY * * * * root $APP/deploy/update.sh >>/var/log/animini-update.log 2>&1" >/etc/cron.d/animini
    ok "автообновление каждые $UPDATE_EVERY мин (cron)"
  fi
}

summary() {
  local bot=${BOT_USERNAME:+@$BOT_USERNAME}
  cat >&2 <<EOF

$(printf '\033[1;32m')Готово!$(printf '\033[0m')

  Сайт и Mini App:  https://$DOMAIN
  Бот:              ${bot:-(проверьте токен)}${BOT_USERNAME:+  →  https://t.me/$BOT_USERNAME}

  В боте уже стоит кнопка меню «Смотреть» — она открывает Mini App.
  Чтобы приложение открывалось и из профиля бота:
    @BotFather → /mybots → ${bot:-ваш бот} → Bot Settings → Configure Mini App → Enable → https://$DOMAIN
  Для ссылок «Поделиться» вида t.me/бот/имя: @BotFather → /newapp, URL https://$DOMAIN,
  потом: sudo animini config (и впишите короткое имя).

  Команды:
    sudo animini status     что запущено и какая версия
    sudo animini logs       логи приложения
    sudo animini update     обновить с GitHub прямо сейчас
    sudo animini config     поменять токен, домен и другие настройки
    sudo animini backup     сохранить базу пользователей
EOF
}

main() {
  [[ $(id -u) -eq 0 ]] || die "Запустите от root: curl -fsSL … | sudo bash"
  open_input
  # Дальше stdin не нужен — чтобы apt и docker не съели остаток скрипта из пайпа.
  exec </dev/null

  printf '\033[1;35m%s\033[0m\n' "AniMini — установка аниме-сайта и Telegram Mini App" >&2
  prepare_system
  say "Бот"
  ask_bot_token
  say "Домен"
  ask_domain
  say "Настройки"
  ask_options
  fetch_code
  write_config
  open_firewall
  start_app
  install_tools
  summary
}

main "$@"
