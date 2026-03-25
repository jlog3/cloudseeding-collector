#!/bin/bash
# ─── Push cloudseeding-collector to GitHub ────────────────────────────────
# Run this from inside the cloudseeding-collector directory.
#
# Prerequisites:
#   - git installed
#   - GitHub CLI (gh) installed and authenticated: gh auth login
#
# Usage: bash push-to-github.sh

set -e

REPO_NAME="cloudseeding-collector"

echo "=== Initializing git repo ==="
git init
git add -A
git commit -m "Initial commit: CONUS-wide flight + weather data collector

- Polls entire continental US via OpenSky Network (ADS-B) + Open-Meteo
- Stores seeding-altitude aircraft (5k-30k ft) in full detail
- Permanently tracks known seeder fleet positions
- 2° weather grid across CONUS (195 points)
- Auto-compacts to ~2 GB/year
- Read-only REST API with /api/correlate endpoint
- Docker + docker-compose support"

echo ""
echo "=== Creating GitHub repo ==="
gh repo create "$REPO_NAME" --public --source=. --push \
  --description "CONUS-wide flight + weather data collector for cloud seeding transparency analysis"

echo ""
echo "=== Done! ==="
echo "Repo: https://github.com/$(gh api user -q .login)/$REPO_NAME"
echo ""
echo "Next steps:"
echo "  1. Deploy to a host (see README for options)"
echo "  2. Run: npm install && node setup-db.js && node collect-loop.js"
