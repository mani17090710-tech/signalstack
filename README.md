# Signalstack

An AI intelligence platform: models, benchmarks, research papers, and documentation
changes in one place, with a source next to every claim.

## What's real vs. demo

- **The app, the database, auth, and the admin dashboard are fully real** — not a mockup.
- **The seed data** (Meridian 3, Aster R2, Kestrel — all fictional) is demo content so the
  app isn't empty on first run. It's clearly labeled in the UI.
- **The ingestion pipeline hits real public APIs**: Hugging Face's model listing,
  GitHub's releases API, and arXiv's search API. New items it finds are stored as
  **pending review** (a `verified` flag) until an admin approves them, so fictional
  demo data and live-ingested data never get silently mixed together.

## Run it locally

Requires Node 22.5+ (uses the built-in `node:sqlite`, no `npm install` needed).

```bash
cd signalstack
cp .env.example .env      # optional — edit if you want email alerts
node --env-file=.env server.js
```

Open `http://localhost:3000`. The **first account you sign up with becomes the admin**
automatically. Everyone after that is a regular user (promote/demote from the admin
dashboard).

## Ingestion

Runs automatically ~10 seconds after boot, then every `INGEST_INTERVAL_MIN` minutes
(default 30). As an admin you can also trigger it manually from **Admin dashboard →
Run ingestion now**.

It fetches from three sources by default (edit `sources_config` in the database, or
add an admin UI for it, to change these):

| Source | What it pulls | Auth needed |
|---|---|---|
| Hugging Face | Newest models | No |
| GitHub | Releases from `huggingface/transformers` (swap the repo in `sources_config`) | No (but rate-limited to 60/hr — set `GITHUB_TOKEN` to raise it to 5,000/hr) |
| arXiv | Recent papers matching a search query | No |

Each source is content-hashed, so unchanged responses are skipped rather than
reprocessed. Failures (rate limits, outages, network errors) are logged per-source in
the admin dashboard and don't affect the rest of the app.

**Note on testing:** I built and unit-tested this pipeline's parsing/dedup logic
against mock data shaped exactly like the real APIs, but I could not make live calls
to huggingface.co / github.com / arxiv.org from the environment I built this in (no
outbound internet access there). The first live run on your machine is the real test —
check **Admin dashboard → Monitored sources** afterward to confirm each one shows
`ok` rather than `error`.

## Email alerts

Uses a small built-in SMTP client (`mailer.js`) — no npm packages required. Configure
`SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` (see `.env.example` for Gmail and
SendGrid examples). Without these set, email alerts fail gracefully with a clear
message in the admin dashboard; in-app and browser-tab notifications still work.

**Note on testing:** I verified the client fails safely when unconfigured, but I
couldn't send a real email from this environment either (same network restriction).
Test it yourself with real credentials before relying on it.

## Browser notifications

These are **tab-open notifications**, not push notifications — the browser tab polls
for new alert matches every 60 seconds while it's open. True background push (via a
service worker and the Push API) would need a public HTTPS domain to register against,
which only exists once this is deployed — ask if you want that added after deployment.

## Deploying

I can't deploy this to a live URL myself (no hosting accounts from where I work), but
it's packaged to deploy in a few minutes on any of these:

### Render / Railway (easiest)
1. Push this folder to a GitHub repo.
2. Create a new **Web Service** from that repo on [render.com](https://render.com) or
   [railway.app](https://railway.app).
3. Build command: none needed. Start command: `node server.js`.
4. Add a **persistent disk** (Render: "Disks"; Railway: a volume) mounted at `/data`,
   and set the environment variable `DB=/data/signalstack.db` so your data survives
   redeploys.
5. Add the SMTP/GITHUB_TOKEN env vars from `.env.example` if you want them.

### Fly.io
```bash
fly launch --no-deploy        # answer prompts, don't let it overwrite Dockerfile
fly volumes create data --size 1
# in fly.toml, mount the volume at /data and set env DB=/data/signalstack.db
fly deploy
```

### Docker anywhere (VPS, etc.)
```bash
docker build -t signalstack .
docker run -d -p 3000:3000 -v signalstack_data:/data \
  -e SMTP_HOST=... -e SMTP_USER=... -e SMTP_PASS=... -e SMTP_FROM=... \
  signalstack
```

In every case: put the SQLite file on a persistent volume, not the container's
ephemeral filesystem, or your data resets on every redeploy.

## Project structure

```
server.js          HTTP server, routing, auth, admin API, scheduler
ingest.js          Fetch/parse/dedupe logic for HF, GitHub, arXiv
mailer.js          Dependency-free SMTP client
public/index.html  Frontend (auth screens + single-page app)
Dockerfile          Container build
.env.example        Config template
```

## API surface

All `/api/*` routes except `/api/signup`, `/api/login`, `/api/logout` require a
session cookie. `/api/admin/*` additionally requires the `admin` role.

`GET /api/models`, `/api/models/:id`, `/api/benchmarks`, `/api/benchmarks/:id`,
`/api/papers`, `/api/events`, `/api/orgs`, `/api/docs`, `/api/docs/diff`,
`/api/search`, `/api/watchlist`, `/api/alerts` · `POST/DELETE /api/watchlist`,
`/api/alerts` · `POST /api/admin/ingest/run`, `/api/admin/review`,
`/api/admin/sources`, `/api/admin/users/role` · `GET /api/admin/summary`,
`/api/admin/log`, `/api/admin/pending`, `/api/admin/users`.
