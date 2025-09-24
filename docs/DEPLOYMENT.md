VibeNote Backend Deployment (NGINX + PM2 + TLS)

This guide makes deploying the backend repeatable with npm scripts. It assumes Ubuntu/Debian with NGINX.

Prereqs
- Node 22+ and npm installed on the VPS
- PM2 globally installed: `npm i -g pm2`
- Domain pointing at the VPS public IP (A/AAAA records)

Environment
- On the VPS, set these in `.env` at the repo root (scripts auto‑load it):
  - `VIBENOTE_API_BASE` (e.g., https://api.vibenote.dev)
  - `CERTBOT_EMAIL` (email for Let’s Encrypt)
- Backend env (secrets) are read by the app via dotenv/.env or system envs (see OAUTH_REFACTOR.md).

Steps
1) Start the backend with PM2
   - `npm run pm2:start`
   - Optional (boot persistence): `pm2 save && pm2 startup` (follow printed command once)

2) Install NGINX config for your domain
   - `npm run nginx:configure`  (reads `VIBENOTE_API_BASE` from .env and renders config)
   - `npm run nginx:test`
   - `npm run nginx:reload`

3) Obtain TLS via Let’s Encrypt (Certbot)
   - `npm run tls:issue`  (reads `VIBENOTE_API_BASE` and `CERTBOT_EMAIL` from .env)
   - This will install certbot if missing, request a cert, and configure NGINX with HTTPS + redirect.

4) Verify
   - `curl -s "$VIBENOTE_API_BASE/v1/healthz"`
   - You should see `{ "ok": true }`

Notes
- The NGINX config proxies only `/v1/*` and `/v1/healthz` to the app on `127.0.0.1:8787`.
- Update `ALLOWED_ORIGINS` on the backend to include your frontend domains.
- If you change ports or paths, re-run `npm run nginx:configure` and then `npm run nginx:reload`.
