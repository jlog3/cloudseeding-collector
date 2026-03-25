# Deployment Guide

Your code lives on GitHub. The collector needs to run somewhere 24/7.
Pick whichever option fits your situation.

## Option 1: Railway.app (easiest, free tier)

Railway gives you a persistent process + a public URL for the API.
Both the collector and API server run in a single service (Railway
doesn't support shared volumes between services).

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# From inside the cloned repo:
railway init
railway up
```

Railway auto-detects the Dockerfile, builds it, runs `start.js` which
launches both the collector loop and the API server in one process.

**After deploy:**

1. Add a **volume**: press `Cmd+K` (or `Ctrl+K`), type "volume",
   select your service, set mount path to `/app/data`
2. Add **environment variables** in the Variables tab:
   ```
   DB_PATH=/app/data/cloudseeding.db
   PORT=4000
   COLLECT_INTERVAL_MS=300000
   ```
3. Under **Settings → Networking**, click **"Generate Domain"**
   to get a public URL for the API
4. Redeploy after adding the volume

**Cost:** Hobby plan is $5/month with $5 included credit. This collector
uses ~$1-2/month of resources — fits within the free credit.


## Option 2: Render.com (free background worker)

1. Go to https://render.com, sign in with GitHub
2. Click "New" → "Web Service" (not background worker — we need the port)
3. Connect your `cloudseeding-collector` repo
4. Build command: `npm install`
5. Start command: `node start.js`
6. Environment: set `DB_PATH=/data/cloudseeding.db` and `PORT=4000`
7. Add a Disk: mount path `/data`, size 1 GB

This runs both the collector and API server. You get a public URL automatically.

**Cost:** Free tier works. Add the disk ($0.25/month for 1 GB).


## Option 3: Fly.io (persistent volume, global edge)

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# From inside the repo:
fly launch           # creates fly.toml
fly volumes create cloudseeding_data --size 1
fly deploy
```

Edit `fly.toml` to mount the volume and expose the API port:
```toml
[mounts]
  source = "cloudseeding_data"
  destination = "/data"

[env]
  DB_PATH = "/data/cloudseeding.db"
  PORT = "4000"

[[services]]
  internal_port = 4000
```

**Cost:** Free tier covers 1 machine with 256MB RAM. Plenty.


## Option 4: Any $4-5/month VPS

DigitalOcean, Vultr, Hetzner, Linode — any Linux box works.

```bash
# SSH in, clone, install, run
ssh root@your-server

git clone https://github.com/YOUR_USER/cloudseeding-collector.git
cd cloudseeding-collector
npm install
node setup-db.js

# Run with pm2 (process manager) — single process handles both
npm install -g pm2
pm2 start start.js --name cloudseeding
pm2 save
pm2 startup  # auto-start on reboot
```

**Cost:** $4-5/month. Most reliable option. Full control.


## Option 5: Docker Compose (on any host)

If your host has Docker:

```bash
git clone https://github.com/YOUR_USER/cloudseeding-collector.git
cd cloudseeding-collector
docker compose up -d
```

This starts both the collector and API server in one container. Data persists in a Docker volume.

```bash
docker compose logs -f    # watch both collector + API output
```


## Option 6: Raspberry Pi at home

```bash
# On the Pi
git clone https://github.com/YOUR_USER/cloudseeding-collector.git
cd cloudseeding-collector
npm install
node setup-db.js
pm2 start start.js --name cloudseeding
pm2 save && pm2 startup
```

The DB writes to the SD card (or better, an external USB drive).
Use a service like ngrok or Cloudflare Tunnel to expose the API publicly.

**Cost:** Free if you have a Pi. Uses ~50MB RAM.


## After deployment

1. Verify it's collecting: visit `http://YOUR_HOST:4000/api/stats`
2. You should see row counts increasing every 5 minutes
3. Update your dashboard's `.env`:
   ```
   NEXT_PUBLIC_COLLECTOR_API=https://your-collector-api.example.com
   ```
4. The Data Explorer in the dashboard will now query your live data


## Backing up the database

The entire dataset is one file: `cloudseeding.db`. Back it up however you want:

```bash
# Simple: copy it periodically
cp cloudseeding.db cloudseeding-backup-$(date +%Y%m%d).db

# On a VPS with cron:
0 4 * * * cp /path/to/cloudseeding.db /backups/cloudseeding-$(date +\%Y\%m\%d).db

# Or sync to cloud storage:
0 4 * * * rclone copy /path/to/cloudseeding.db r2:my-bucket/backups/
```
