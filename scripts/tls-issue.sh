#!/usr/bin/env bash
set -euo pipefail

# Load .env if present for VIBENOTE_API_BASE and CERTBOT_EMAIL
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
_tmp="${VIBENOTE_API_BASE#*://}"
DOMAIN="${_tmp%%/*}"
if [[ -z "${CERTBOT_EMAIL:-}" ]]; then
  echo "ERROR: CERTBOT_EMAIL not set. Add CERTBOT_EMAIL to .env or export it and re-run." >&2
  exit 1
fi

if ! command -v certbot >/dev/null 2>&1; then
  echo "Installing certbot + nginx plugin..."
  if command -v apt >/dev/null 2>&1; then
    sudo apt update
    sudo apt install -y certbot python3-certbot-nginx
  else
    echo "apt not found. Please install certbot manually for your distro." >&2
    exit 1
  fi
fi

sudo certbot --nginx -d "$DOMAIN" \
  --non-interactive --agree-tos -m "$CERTBOT_EMAIL" --redirect

echo "TLS issued/renewed for $DOMAIN. NGINX reloaded by certbot."
