#!/bin/sh
set -eu

if [ -n "${CODEX_AUTH_GZIP_B64:-}" ]; then
  mkdir -p /root/.codex
  printf '%s' "$CODEX_AUTH_GZIP_B64" | base64 -d | gzip -d > /root/.codex/auth.json
  chmod 600 /root/.codex/auth.json
fi

exec node /app/build/container/server.js
