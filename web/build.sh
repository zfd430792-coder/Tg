#!/bin/sh
# Bundles the UI sources into assets/app.js (no other build step needed).
set -eu
cd "$(dirname "$0")"
cat src/1-core.js src/2-sky.js src/3-files.js src/4-app.js > assets/app.js
