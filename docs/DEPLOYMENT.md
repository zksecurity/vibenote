VibeNote Backend Deployment (NGINX + PM2 + TLS)

This guide makes deploying the backend repeatable with npm scripts. It assumes Ubuntu/Debian with NGINX.

Prereqs

- Node 22+ and npm installed on the VPS
- PM2 globally installed: `npm i -g pm2`
- Domain pointing at the VPS public IP (A/AAAA records)

Environment

- On the VPS, set variables in `.env` at the repo root (scripts and app auto‑load them)

Steps

1. Start the backend with PM2

   - `npm run pm2:start`
   - Optional (boot persistence): `pm2 save && pm2 startup` (follow printed command once)

2. Install NGINX config for your domain

   - `npm run nginx:configure` (reads `VIBENOTE_API_BASE` from .env and renders config)
   - `npm run nginx:test`
   - `npm run nginx:reload`

3. Obtain TLS via Let’s Encrypt (Certbot)

   - `npm run tls:issue` (reads `VIBENOTE_API_BASE` and `CERTBOT_EMAIL` from .env)
   - This will install certbot if missing, request a cert, and configure NGINX with HTTPS + redirect.
   - Renewal:
     - Certbot installs a systemd timer on Ubuntu/Debian and renews automatically.
     - To force a renewal now: `npm run tls:renew`
     - To test renewal without changing certs: `npm run tls:renew:dry-run`

4. Verify
   - `curl -s "$VIBENOTE_API_BASE/v1/healthz"`
   - You should see `{ "ok": true }`
   - If you hit the domain without scheme or over HTTP (http://), a `301 Moved Permanently` is expected after TLS setup. Use HTTPS or `-L` to follow the redirect.

Notes

- The NGINX config proxies only `/v1/*` and `/v1/healthz` to the app on `127.0.0.1:8787`.
- Update `ALLOWED_ORIGINS` on the backend to include your frontend domains.
- If you change ports or paths, re-run `npm run nginx:configure` and then `npm run nginx:reload`.
