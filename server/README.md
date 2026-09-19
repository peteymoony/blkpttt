# Self-hosted Blockpit stack

Everything runs on your VPS — no Firebase, no third-party hosting. The site
is served by Caddy (with automatic TLS), sign-ups/logins go to the Node API,
accounts live in Postgres, and Telegram notifications go straight from the
API to your bot.

## What's in here

| File | Purpose |
|---|---|
| `server.js` | Auth API (`/api/auth`, `/api/session`) + admin Telegram webhook (`/api/telegram-webhook`) |
| `Dockerfile` | Builds the Node API image |
| `docker-compose.yml` | Postgres + API + Caddy, one command |
| `Caddyfile` | Serves the site + proxies `/api/*` + automatic HTTPS |
| `.env.example` | All configuration (copy to `.env`) |

## Requirements

- A VPS with Docker and the Docker Compose plugin installed.
- A domain (or subdomain) whose **A record points to the VPS IP**.
- Ports 80 and 443 open.

## Setup (5 minutes)

```bash
# 1. Copy this whole project folder to the VPS, then:
cd server

# 2. Configure
cp .env.example .env
#    - DB_PASSWORD: pick a strong one
#    - JWT_SECRET:  openssl rand -hex 32
#    - TELEGRAM_WEBHOOK_SECRET: openssl rand -hex 16
#    - token + chat ID are already filled in
nano .env

# 3. Put your domain into the Caddyfile (replace your-domain.com)

# 4. Start everything
docker compose up -d --build

# 5. Point the Telegram bot at the webhook (after DNS resolves and TLS is up):
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-domain.com/api/telegram-webhook%3Fkey%3D<WEBHOOK_SECRET>"
```

Then open `https://your-domain.com` — first email+password signs straight
through (account auto-created), same credentials keep working, sessions last
30 days, and every sign-up/login messages your Telegram. Send your bot
`/stats` for account counts.

## Local testing first (recommended)

The same compose file runs on your own machine before you touch the VPS —
swap the Caddyfile domain for a plain local listener:

```
:80 {
	root * /srv/site
	encode gzip
	@blocked path /server*
	handle @blocked { respond 404 }
	@api path /api/*
	reverse_proxy @api app:3000
	file_server
}
```

Then `docker compose up -d --build` and open **http://localhost** — the whole
site works locally: sign-ups/logins hit the local Postgres container, and the
Telegram messages go out as long as your machine can reach Telegram (check
`getWebhookInfo` if they don't arrive). When you're happy, point a domain at
the VPS, restore the domain Caddyfile, and run the same command there.

## How the pieces fit

```
browser ──HTTPS──> Caddy ──/api/*──> Node API ──> Postgres
                        │                │
                        └── static ── site files    └───> Telegram (bot API)
```

Only outbound call in the whole system is Telegram's API. Passwords are
bcrypt-hashed, auth is rate-limited (60 tries / 15 min / IP), sessions are
signed JWTs, and the webhook needs the secret key plus your chat ID.
