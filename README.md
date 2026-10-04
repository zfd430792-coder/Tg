# Tg — своё облако на базе Pentaract

Облачное хранилище, которое хранит файлы в приватном Telegram-канале: файл режется на куски по 20 МБ, боты отправляют их в канал, а карта кусков лежит в PostgreSQL.

## Что здесь лежит

- `Pentaract/` — исходный код [Dominux/Pentaract](https://github.com/Dominux/Pentaract) (лицензия MIT, см. `Pentaract/LICENSE`): сервер на Rust и интерфейс на SolidJS в `Pentaract/ui`.
- `design/pentaract-prototype.html` — выбранный дизайн нового интерфейса (открывается в браузере, работает без сервера).
- `design/pentaract-cyberpunk.html` — альтернативный вариант в стиле киберпанк.
- `web/` — новый интерфейс (без сборщика): исходники в `web/src`, `web/build.sh` склеивает их в `web/assets/app.js`. Работает с API оригинального Pentaract.

## Что планируется

- Закрыть открытую регистрацию: аккаунты выдаёт администратор.
- Принимать ID канала и с `-100`, и без.
- Исправить пропадание хранилища из списка, когда в нём остались только папки.
- Собирать Docker-образ через GitHub Actions и разворачивать на VPS за Caddy с HTTPS.

## Развёртывание

Файлы для сервера лежат в `deploy/`: Docker Compose с Caddy (HTTPS выпускается автоматически), Pentaract и Postgres, а также скрипт ежедневного бэкапа базы.

1. Установить Docker: `apt install docker.io docker-compose-v2`.
2. Скопировать `deploy/` в `/opt/pentaract`, рядом создать `.env` по образцу `deploy/.env.example` (секреты — `openssl rand -hex 32`), а содержимое `web/` (кроме `src/`) положить в `/opt/pentaract/ui`.
3. `docker compose up -d`.
4. Бэкап: `/etc/cron.d/pentaract-backup` → `30 3 * * * root /opt/pentaract/backup.sh`.

Открытая регистрация закрыта на уровне Caddy: `POST /api/users` возвращает 403.
