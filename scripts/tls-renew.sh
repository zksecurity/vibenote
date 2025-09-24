#!/usr/bin/env bash
set -euo pipefail

# Load .env if present (not strictly required for renewal)
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
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

# Renew all certs if due; reload NGINX when a cert is deployed
sudo certbot renew --nginx --deploy-hook 'systemctl reload nginx'

echo "Certbot renewal run complete. If any certificates were renewed, NGINX was reloaded."

