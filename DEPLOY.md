# Deployment Guide (v2)

Your code lives on GitHub; the collector runs somewhere 24/7. The deploy
mechanics are unchanged from v1 — the only additions are a few environment
variables and a one-time registry build. Pick whichever host fits.

> **Environment variables (all hosts).** Beyond `DB_PATH`/`PORT`, v2 adds:
> ```
> OPENSKY_CLIENT_ID=...        # OAuth2 client — strongly recommended (stops 429s)
> OPENSKY_CLIENT_SECRET=...
> OBSERVATION_SOURCE=openmeteo # or mrms / goes (needs OBSERVATION_SIDECAR_URL)
> ```
> Create an OpenSky API client at https://opensky-network.org/ (account → API
> clients). See `.env.example` for the full list.

> **One-time after first deploy: build the seeder registry.**
> ```
> node fetch-faa-seeders.js
> ```
> Run it in the deployed environment (or locally, then commit `data/seeders.json`).
> Re-run monthly. Without it, the icao24 known-seeder matcher is empty.

> **Upgrading an existing v1 deployment.** `setup-db.js` migrates the schema in
> place (adds the new tables/columns). Then optionally clear the old false
> positives so the new detector rebuilds cleanly:
> ```
> node reset-preservation.js     # wipes derived tables only; raw data is kept
> ```

---

## Option 1: Railway.app (easiest)

Both collector and API run in one service (Railway has no shared volumes).

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

Railway auto-detects the Dockerfile and runs `start.js`.

**After deploy:**
1. Add a **volume** (Cmd/Ctrl+K → "volume"), mount path `/app/data`.
2. **Variables** tab:
   ```
   DB_PATH=/app/data/cloudseeding.db
   PORT=4000
   COLLECT_INTERVAL_MS=300000
   OPENSKY_CLIENT_ID=...
   OPENSKY_CLIENT_SECRET=...
   OBSERVATION_SOURCE=openmeteo
   ```
3. **Settings → Networking → Generate Domain** for the public API URL.
4. Redeploy after adding the volume.
5. One-time: open a shell (`railway run node fetch-faa-seeders.js`) to build the registry.

**Cost:** Hobby plan ~$5/mo with $5 credit; this uses ~$1–2/mo.

---

## Option 2: Render.com

1. New → **Web Service**, connect the repo.
2. Build: `npm install` · Start: `node start.js`.
3. Env: `DB_PATH=/data/cloudseeding.db`, `PORT=4000`, OpenSky creds.
4. Add a **Disk** mounted at `/data` (1 GB).
5. Shell once: `node fetch-faa-seeders.js`.

---

## Option 3: Fly.io

```bash
curl -L https://fly.io/install.sh | sh
fly launch
fly volumes create cloudseeding_data --size 1
fly deploy
```

`fly.toml`:
```toml
[mounts]
  source = "cloudseeding_data"
  destination = "/data"
[env]
  DB_PATH = "/data/cloudseeding.db"
  PORT = "4000"
  OBSERVATION_SOURCE = "openmeteo"
[[services]]
  internal_port = 4000
```
Set OpenSky secrets with `fly secrets set OPENSKY_CLIENT_ID=... OPENSKY_CLIENT_SECRET=...`.
Then `fly ssh console -C "node fetch-faa-seeders.js"`.

---

## Option 4: Any $4–5/mo VPS

```bash
git clone https://github.com/YOUR_USER/cloudseeding-collector.git
cd cloudseeding-collector
npm install
cp .env.example .env && nano .env        # add OpenSky creds
node setup-db.js
node fetch-faa-seeders.js
npm install -g pm2
pm2 start start.js --name cloudseeding
pm2 save && pm2 startup
```

On a plain VM you can use cron instead of the in-process loop — see
`crontab.sample` (collect every 5 min, monitor+vacuum daily, aggregate daily).

---

## Option 5: Docker Compose

```bash
cp .env.example .env       # docker-compose.yml reads OPENSKY_* / OBSERVATION_SOURCE
docker compose up -d
docker compose exec cloudseeding node fetch-faa-seeders.js
docker compose logs -f
```

---

## Optional: real-observation sidecar (mrms / goes)

To swap the model "actual" for real radar/satellite, run a small HTTP service
that parses NOAA products and returns normalized cells, then set:
```
OBSERVATION_SOURCE=mrms          # or goes
OBSERVATION_SIDECAR_URL=http://sidecar:8080
```
The sidecar must answer `GET /observations?hour=&kind=&latMin=&latMax=&lngMin=&lngMax=`
with `{ "cells": [ { lat, lng, cloud_cover, cloud_top_temp_c, precip_rate, ... } ] }`.
If it's unreachable the collector automatically falls back to the model grid and
flags the cycle as degraded — the pipeline never goes dark.

---

## After deployment

1. Check `https://YOUR_HOST/api/stats` — row counts should climb every 5 min.
2. Watch `https://YOUR_HOST/api/airframes` after data accumulates (days/weeks).
3. Point the website at it: `NEXT_PUBLIC_COLLECTOR_API=https://your-collector...`.

## Backups

The dataset is one file:
```bash
cp cloudseeding.db cloudseeding-backup-$(date +%Y%m%d).db
# or: rclone copy cloudseeding.db r2:my-bucket/backups/
```
