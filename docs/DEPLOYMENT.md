VibeNote Backend Deployment

You can run the GitHub App backend either on Vercel (serverless) or on a self-managed VPS. Both use the same environment variables and code paths. Pick the option that suits your needs, or keep the VPS setup as a fallback.

---

## Option A: Vercel serverless API

1. **Create/Select a Vercel project** pointing at this repository (the project root contains both the frontend and the `/api` backend handlers).

2. **Set environment variables** in Vercel (Preview + Production): See `.env.example`

3. **Deploy** via the Vercel dashboard or CLI. The routes are exposed under `/api/v1/...` and the health check is `/api/v1/healthz`.

4. **Switch the frontend** by updating `VIBENOTE_API_BASE` in Vercel’s project env (and locally, if needed) to point at the serverless API (e.g. `https://<your-app>.vercel.app/api`). No further code changes are needed.

---

## Option B: VPS backend (NGINX + PM2 + TLS)

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
