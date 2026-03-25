# Deployment Guide

Your code lives on GitHub. The collector needs to run somewhere 24/7.
Pick whichever option fits your situation.

## Option 1: Railway.app (easiest, free tier)

Railway gives you a persistent process + a public URL for the API.

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# From inside the cloned repo:
railway init
railway up
```

That's it. Railway reads the Dockerfile, builds it, runs `collect-loop.js`.
The SQLite file persists in the container's filesystem.

To also run the API server, add a second service in the Railway dashboard
pointing to the same repo with the start command `node serve.js`.

**Cost:** Free tier covers this easily. The collector uses ~50MB RAM and
negligible CPU (one API call every 5 minutes).


## Option 2: Render.com (free background worker)

1. Go to https://render.com, sign in with GitHub
2. Click "New" → "Background Worker"
3. Connect your `cloudseeding-collector` repo
4. Build command: `npm install`
5. Start command: `node collect-loop.js`
6. Environment: set `DB_PATH=/data/cloudseeding.db`
7. Add a Disk: mount path `/data`, size 1 GB

For the API, create a second "Web Service" from the same repo:
- Start command: `node serve.js`
- It gets a public URL automatically.

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

Edit `fly.toml` to mount the volume:
```toml
[mounts]
  source = "cloudseeding_data"
  destination = "/data"

[env]
  DB_PATH = "/data/cloudseeding.db"
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

# Run with pm2 (process manager)
npm install -g pm2
pm2 start collect-loop.js --name collector
pm2 start serve.js --name collector-api
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

This starts both the collector and API server. Data persists in a Docker volume.

```bash
docker compose logs -f collector  # watch collection cycles
docker compose logs -f api        # watch API requests
```


## Option 6: Raspberry Pi at home

```bash
# On the Pi
git clone https://github.com/YOUR_USER/cloudseeding-collector.git
cd cloudseeding-collector
npm install
node setup-db.js
pm2 start collect-loop.js --name collector
pm2 start serve.js --name collector-api
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
