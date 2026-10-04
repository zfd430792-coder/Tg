#!/bin/sh
# Daily Postgres dump. The database is the only map of which Telegram chunk
# belongs to which file, so losing it means losing every file.
set -eu
umask 077
cd "$(dirname "$0")"
. ./.env
mkdir -p backups
docker compose exec -T db pg_dump -U "$DATABASE_USER" -Fc "$DATABASE_NAME" > "backups/pentaract-$(date +%F).dump"
find backups -name 'pentaract-*.dump' -mtime +14 -delete
