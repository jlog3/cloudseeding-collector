# cloudseeding-collector

Standalone data collector for the [CloudSeeding Transparency](https://github.com/YOUR_USERNAME/cloudseeding-transparency) project. Polls real-time flight tracking and weather data across the entire continental US, stores it in a local SQLite database for historical correlation analysis.

**Runs independently of the dashboard.** Start collecting now, analyze later.

## What it does

Every 5 minutes:

1. **Pulls every aircraft over the continental US** from the [OpenSky Network](https://opensky-network.org/) ADS-B API — one call, ~5,000-7,000 aircraft
2. **Stores full detail for seeding-altitude aircraft** (5,000–30,000 ft) — callsign, exact position, altitude, speed, heading, vertical rate
3. **Permanently tracks known seeder aircraft** (Weather Modification Inc fleet, etc.) at any altitude
4. **Queries weather for a 2° grid** (~195 points) across CONUS from [Open-Meteo](https://open-meteo.com/) — cloud cover, precipitation, humidity, wind, pressure
5. **Compacts older flight data** into per-callsign hourly summaries after 48 hours

The result is a single `cloudseeding.db` file that grows ~2 GB/year and contains everything needed to answer: *"Which aircraft were at seeding altitude near this location in the hours before cloud cover changed?"*

## Quick start

```bash
git clone https://github.com/YOUR_USERNAME/cloudseeding-collector.git
cd cloudseeding-collector
npm install
node setup-db.js      # create the database
node collect.js       # run one collection cycle
```

## Running continuously

### Option A: Loop process (simplest)

```bash
# Foreground
node collect-loop.js

# Background
nohup node collect-loop.js >> collector.log 2>&1 &

# With pm2
pm2 start collect-loop.js --name cloudseeding-collector
```

### Option B: Cron

```bash
# Every 5 minutes
*/5 * * * * cd /path/to/cloudseeding-collector && node collect.js >> collector.log 2>&1
```

### Option C: Docker

```bash
docker compose up -d    # starts collector + API server
```

## API server

The API server is a read-only REST interface over the database. The dashboard queries it to hydrate historical data.

```bash
node serve.js           # default port 4000
PORT=8080 node serve.js # custom port
```

### Key endpoints

| Endpoint | Description |
|---|---|
| `GET /api/correlate?lat=39.87&lng=-75.31&hours=24` | **Primary** — weather + flight data aligned by hour |
| `GET /api/flights?lat=39.87&lng=-75.31&hours=48` | Recent flight detail (seeding altitude, 48h window) |
| `GET /api/flights/history?lat=39.87&lng=-75.31&days=30` | Compacted hourly flight data for long-term analysis |
| `GET /api/weather?lat=39.87&lng=-75.31&hours=24` | Hourly weather from nearest grid point |
| `GET /api/seeders?hours=168` | All known seeder positions (permanent, full detail) |
| `GET /api/traffic?hours=168` | CONUS-wide hourly traffic totals by altitude band |
| `GET /api/stats` | Database size, row counts, date ranges |

## Data architecture

### What gets stored (and why)

```
┌──────────────────────┬───────────────┬─────────────────────────────────────┐
│ Table                │ Retention     │ Why                                 │
├──────────────────────┼───────────────┼─────────────────────────────────────┤
│ weather_grid         │ Forever       │ Cloud/precip data for correlation   │
│ seeder_tracks        │ Forever       │ Every known seeder position ever    │
│ flight_hourly_detail │ Forever       │ Per-callsign hourly positions —     │
│                      │               │ the unknown-seeder detection pool   │
│ traffic_hourly_summary│ Forever      │ CONUS-wide traffic by altitude band │
│ flights_seeding_alt  │ 48h rolling   │ Full detail for recent analysis     │
└──────────────────────┴───────────────┴─────────────────────────────────────┘
```

### Altitude filtering

| Band | Range | Storage | Rationale |
|---|---|---|---|
| **Seeding altitude** | 5,000–30,000 ft | Full detail | Cloud seeding ops happen here |
| High altitude | >30,000 ft | Count only | Commercial cruisers, not seeding |
| Low altitude | <5,000 ft | Count only | Departures/arrivals, not seeding |
| Known seeders | Any altitude | **Full detail, forever** | Always track these |

### Storage estimates

| Timeframe | Database size |
|---|---|
| 1 day | ~55 MB peak (pre-compaction) |
| 1 week | ~150 MB |
| 1 month | ~300 MB |
| 1 year | ~2 GB |
| 5 years | ~10 GB |

## Schema

```
weather_grid                         ← CONUS 2° grid, kept forever
├── grid_lat, grid_lng, timestamp
├── temperature, humidity, dewpoint
├── wind_speed, wind_dir
├── precip_rate, precip_prob
├── cloud_cover, cloud_cover_low, cloud_cover_mid, cloud_cover_high
├── pressure, visibility

flights_seeding_alt                  ← 48h rolling detail
├── poll_time, icao24, callsign
├── lat, lng, altitude_ft, speed_kts, heading, vertical_rate
├── squawk, is_known_seeder, operator, aircraft_type

seeder_tracks                        ← permanent, full resolution
├── poll_time, icao24, callsign
├── lat, lng, altitude_ft, speed_kts, heading, vertical_rate
├── squawk, operator, aircraft_type

flight_hourly_detail                 ← compacted from flights_seeding_alt, kept forever
├── hour, callsign, icao24
├── is_known_seeder, operator, aircraft_type
├── position envelope: min/max/avg lat, lng
├── altitude envelope: min/max/avg alt
├── avg_speed_kts, avg_heading, sightings

traffic_hourly_summary               ← CONUS-wide counts per hour
├── hour
├── total_aircraft, seeding_alt_aircraft, high_alt_aircraft, low_alt_aircraft
├── known_seeder_count, known_seeder_callsigns
```

## Future: unknown seeder detection

The `flight_hourly_detail` table is designed for this. Once you have weeks/months of data, the analysis query is:

```sql
-- Find aircraft that were at seeding altitude near a location
-- in the 1-4 hours before a significant cloud cover increase
SELECT fhd.callsign, fhd.hour, fhd.avg_alt_ft, fhd.avg_lat, fhd.avg_lng,
       w1.cloud_cover as cloud_before, w2.cloud_cover as cloud_after
FROM flight_hourly_detail fhd
JOIN weather_grid w1 ON w1.timestamp = fhd.hour
  AND ABS(w1.grid_lat - fhd.avg_lat) < 2
  AND ABS(w1.grid_lng - fhd.avg_lng) < 2
JOIN weather_grid w2 ON w2.timestamp = datetime(fhd.hour, '+3 hours')
  AND w2.grid_lat = w1.grid_lat AND w2.grid_lng = w1.grid_lng
WHERE w2.cloud_cover - w1.cloud_cover > 25    -- significant increase
  AND fhd.avg_alt_ft BETWEEN 5000 AND 30000
ORDER BY (w2.cloud_cover - w1.cloud_cover) DESC;
```

Aircraft that repeatedly appear in this result set across many events are strong candidates for previously unknown cloud seeding operations.

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `DB_PATH` | `./cloudseeding.db` | Path to SQLite database file |
| `PORT` | `4000` | API server port |
| `COLLECT_INTERVAL_MS` | `300000` | Collection loop interval (5 min) |

## Data sources & attribution

- **Flight data**: [OpenSky Network](https://opensky-network.org/) — free ADS-B data, cite: *Schäfer et al., "Bringing Up OpenSky: A Large-scale ADS-B Sensor Network for Research," IPSN 2014*
- **Weather data**: [Open-Meteo](https://open-meteo.com/) — free weather API, CC BY 4.0
- **Seeding zones**: [NOAA Weather Modification Activity Reports](https://www.weather.gov/media/slc/ClimateNarrative/WMA/WMA.pdf)

## License

MIT — see [LICENSE](LICENSE).
