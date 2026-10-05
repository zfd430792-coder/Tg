#!/usr/bin/env bash
# Собирает тестовую «серию» в HLS в трёх качествах для мок-сервера.
# CODEC=h264 — как у настоящего AniLiberty (TS-сегменты, работает в обычных браузерах);
# CODEC=vp9  — fMP4 с VP9/Opus, для headless Chromium из Playwright, где нет H.264.
set -euo pipefail

CODEC="${CODEC:-h264}"
DURATION="${DURATION:-60}"
OUT="$(cd "$(dirname "$0")" && pwd)/media"
FONT="$(fc-match -f '%{file}' 'DejaVu Sans:bold' 2>/dev/null || true)"

rm -rf "$OUT" && mkdir -p "$OUT"

for spec in 480:854:900k 720:1280:2000k 1080:1920:4000k; do
  IFS=: read -r height width bitrate <<<"$spec"
  dir="$OUT/$height"
  mkdir -p "$dir"
  label="drawtext=fontfile=${FONT}:fontsize=h/9:fontcolor=white:box=1:boxcolor=black@0.5:x=(w-tw)/2:y=h/8:text='${height}p  %{pts\\:hms}'"
  op="drawtext=fontfile=${FONT}:fontsize=h/12:fontcolor=yellow:x=(w-tw)/2:y=h*0.7:text='ОПЕНИНГ':enable='between(t,5,25)'"
  ed="drawtext=fontfile=${FONT}:fontsize=h/12:fontcolor=cyan:x=(w-tw)/2:y=h*0.7:text='ЭНДИНГ':enable='between(t,45,58)'"
  input=(-f lavfi -i "testsrc2=size=${width}x${height}:rate=24:duration=${DURATION}" -f lavfi -i "sine=frequency=440:duration=${DURATION}")

  if [[ "$CODEC" == "vp9" ]]; then
    ffmpeg -hide_banner -loglevel error -y "${input[@]}" -vf "$label,$op,$ed" \
      -c:v libvpx-vp9 -b:v "$bitrate" -deadline realtime -cpu-used 8 -row-mt 1 -g 48 -keyint_min 48 \
      -c:a libopus -b:a 96k -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_type fmp4 \
      -hls_fmp4_init_filename init.mp4 -hls_segment_filename "$dir/seg%03d.m4s" "$dir/index.m3u8"
  else
    ffmpeg -hide_banner -loglevel error -y "${input[@]}" -vf "$label,$op,$ed" \
      -c:v libx264 -preset veryfast -b:v "$bitrate" -g 48 -keyint_min 48 -sc_threshold 0 -pix_fmt yuv420p \
      -c:a aac -b:a 128k -f hls -hls_time 4 -hls_playlist_type vod \
      -hls_segment_filename "$dir/seg%03d.ts" "$dir/index.m3u8"
  fi
  echo "готово: ${height}p"
done
