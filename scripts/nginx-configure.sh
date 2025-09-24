#!/usr/bin/env bash
set -euo pipefail

# Load .env if present to pick up VIBENOTE_API_BASE / CERTBOT_EMAIL
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# Derive DOMAIN from VIBENOTE_API_BASE
if [[ -z "${VIBENOTE_API_BASE:-}" ]]; then
  echo "ERROR: VIBENOTE_API_BASE not set in .env (e.g., https://api.example.com)" >&2
  exit 1
fi
_tmp="${VIBENOTE_API_BASE#*://}"   # strip protocol
DOMAIN="${_tmp%%/*}"                # strip path

CONF_SRC="docs/nginx.config.example"
CONF_DST="/etc/nginx/sites-available/vibenote.conf"

if [[ ! -f "$CONF_SRC" ]]; then
  echo "ERROR: $CONF_SRC not found (run from repo root)." >&2
  exit 1
fi

TMP_CONF=$(mktemp)
sed "s/api.example.com/${DOMAIN//\//\/}/g" "$CONF_SRC" > "$TMP_CONF"

sudo cp "$TMP_CONF" "$CONF_DST"
sudo ln -sf "$CONF_DST" /etc/nginx/sites-enabled/vibenote.conf
rm -f "$TMP_CONF"

echo "Wrote $CONF_DST with server_name $DOMAIN and enabled site."
echo "Run: npm run nginx:test && npm run nginx:reload"
