# Signalstack

An AI intelligence platform: models, benchmarks, research papers, and documentation
changes in one place, with a source next to every claim.

## What it shows

Everything on the site is collected from real public sources, with a link back to each one.
There is no demo data by default (set `SEED_DEMO=true` only if you want fictional sample data for
development).

- **Models:** the Hugging Face Hub. First run loads the 1,000 newest models plus the 500 most-liked
  ones, then every new model is added each cycle. Hugging Face hosts millions of repositories, so this
  is a live, searchable slice of it, not a full mirror. Old unpopular auto-collected models are pruned
  after 45 days to keep the database small.
- **Research:** recent arXiv papers in cs.CL, cs.LG, cs.AI and cs.CV (300 per category on first run, then
  everything new each cycle).
- **Live changes:** trending models, new releases of key open-source projects (transformers, llama.cpp,
  vLLM, Ollama, diffusers, the OpenAI and Anthropic Python SDKs), and announcements from OpenAI, Google
  DeepMind and the Hugging Face blog.
- **Benchmarks / Documentation:** hidden until there is data for them (no live source is connected).

## Run it locally

Requires Node 22.5+ (uses the built-in `node:sqlite`, no `npm install` needed).

```bash
cd signalstack
node server.js            # add env vars from the table below as needed
```

Open `http://localhost:3000`. The **first account you sign up with becomes the admin**
automatically. Everyone after that is a regular user (promote/demote from the admin
dashboard).

## Ingestion

Runs about 10 seconds after boot, then every `INGEST_INTERVAL_MIN` minutes (default 30, minimum 5).
Admins can also trigger it from **Admin dashboard → Run ingestion now**. Sources are rows in the
`sources_config` table (editable in the database); the admin dashboard shows each source's last run and
any error.

- The **first run of each source is a backfill**: it fills the catalog but creates few events and sends
  no alert emails, so a fresh deploy doesn't flood anyone.
- Later runs stop paging as soon as a page is entirely known, so they stay cheap.
- Items are published immediately. Set `REQUIRE_REVIEW=true` to hold new models and papers for admin
  approval instead.
- A failing source is logged and never affects the others.

| Variable | Purpose |
|---|---|
| `INGEST_INTERVAL_MIN` | Minutes between runs (default 30) |
| `HF_TOKEN` | Optional Hugging Face token (higher rate limits) |
| `GITHUB_TOKEN` | Optional; raises GitHub's limit from 60 to 5,000 requests/hour |
| `RETENTION_DAYS` | How long papers are kept (default 365) |
| `REQUIRE_REVIEW` | `true` = new items wait for admin approval |
| `RESEND_API_KEY` / `RESEND_FROM` | Enables alert emails (see below) |
| `OPERATOR_NAME`, `CONTACT_EMAIL`, `JURISDICTION` | Fill in the Terms and Privacy pages |
| `DB` | SQLite path (use a persistent disk, e.g. `/data/signalstack.db`) |

**Testing note:** the parsing, paging, de-duplication and backfill logic is tested against mock
responses shaped like the real APIs. The sandbox this was built in could not reach the live sites, so
check **Admin dashboard → Monitored sources** after your first deploy: every source should show `ok`.

**Free hosting caveat:** free web services sleep when idle (ingestion pauses while asleep) and often
have no persistent disk (the database resets on restart and is rebuilt by the next backfill). For
always-fresh data use an always-on plan with a disk mounted at `/data`.

## Email alerts

Alert emails are sent through [Resend](https://resend.com) over HTTPS (`mailer.js`). Set
`RESEND_API_KEY` (and optionally `RESEND_FROM`). Without it, email alerts fail gracefully; in-app and
browser-tab notifications still work. Test it from the admin dashboard with real credentials before
relying on it.

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
5. Add the environment variables from the table in the Ingestion section (at least `OPERATOR_NAME`, `CONTACT_EMAIL`, `JURISDICTION`; `RESEND_API_KEY` for email alerts).
6. Use Node 22.5+ (set `NODE_VERSION=22` on Render), or choose the Docker runtime.

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
  -e RESEND_API_KEY=... -e OPERATOR_NAME=... -e CONTACT_EMAIL=... -e JURISDICTION=... \
  signalstack
```

In every case: put the SQLite file on a persistent volume, not the container's
ephemeral filesystem, or your data resets on every redeploy.

## Project structure

```
server.js          HTTP server, routing, auth, admin API, scheduler
ingest.js          Fetch/parse/dedupe logic for Hugging Face, arXiv, GitHub and blog feeds
mailer.js          Email alerts via the Resend HTTPS API
public/index.html  Frontend (auth screens + single-page app)
Dockerfile          Container build
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
