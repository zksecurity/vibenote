#!/usr/bin/env bash
set -euo pipefail

if ! command -v certbot >/dev/null 2>&1; then
  echo "Certbot not installed. Install with your package manager (e.g., apt install certbot python3-certbot-nginx)." >&2
  exit 1
fi

sudo certbot renew --nginx --dry-run --deploy-hook 'systemctl reload nginx'

echo "Dry-run renewal complete."

