# cloudseeding-collector (v2)

CONUS-wide flight + weather collector with a **layered, wind-coupled, observation-aware** detector for cloud-seeding aircraft, and an **aggregate "repeat offender" test** that surfaces airframes appearing upwind of suspicious weather far more often than their flight volume can explain.

Runs independently of the website. Collect now, analyze continuously.

---

## What changed from v1 (and why)

The v1 detector was **aircraft-first**: find loitering planes, then look for nearby weather. On national air traffic that produced almost pure noise (every one of its 1,577 "events" was a false positive; zero involved a real known seeder). v2 inverts and layers the logic, and fixes the data pipeline that was failing.

| Area | v1 | v2 |
|---|---|---|
| **Identity** | callsign (mutable, spoofable) | **icao24** (stable per airframe), matched against a real registry |
| **Detection** | loiter → nearby weather | **anomaly-first → backtrack UPWIND along the wind → score aircraft** |
| **Baseline** | "forecast said dry but it rained" (mostly forecast error) | **persisted forward forecasts**, then *actual vs what-was-predicted-hours-ago* — a real counterfactual |
| **Seedability** | none | **gate**: an anomaly only counts if the cloud could plausibly hold supercooled liquid water |
| **Flights** | anonymous OpenSky (429s, "fetch failed") | **OpenSky OAuth2** + `airplanes.live` fallback |
| **Weather** | ~420 sequential Open-Meteo calls/sweep | **batched** multi-point requests |
| **Proof model** | single events | **aggregation with a permutation null + FDR** — repetition is the signal |

> **Honest framing.** Detecting a seeding *effect* from a single event is effectively impossible — documented effects are single-digit-percent precipitation changes, well inside natural variability. This tool does **not** claim to prove seeding. It surfaces **candidates worth a human look**: aircraft whose flight patterns + wind-coupling + repetition stand out from chance.

---

## The pipeline

Every 5 minutes (`collect.js`):

1. **Ingest flights** (`sources/flights.js`) CONUS-wide, normalized to icao24. OpenSky OAuth2 → anonymous → `airplanes.live` (free, *unfiltered* — it shows airframes that suppress themselves from FAA feeds, exactly the population of interest).
2. **Classify** each airframe against the **seeder_registry** (`seeders.js`) by icao24.
3. **Store** the seeding-band aircraft (rolling 48 h full-resolution) + known seeders forever.
4. **Ingest weather** (`sources/weather.js`): the current grid **and** the forward forecast for the next 12 h (persisted → the baseline).
5. **Analyze** (`analysis.js`):
   - **Layer 1 — anomalies.** Cells where observed cloud/precip exceeded the *earliest* forecast for that hour (or, during warm-up, hour-over-hour persistence). Adjacent cells are clustered; each cluster's **linear structure** (a seeding line vs a blob) and **seedability** are measured.
   - **Layer 2 — candidates.** For each anomaly, project **upwind** using the local wind across plausible lags (0.5–3 h) and score aircraft that were there before it: track geometry (racetrack/orbit, straight pass), altitude band, speed, **wind-coupling distance**, and **perpendicularity to wind** (seeding legs run across the wind).
   - **Layer 3 — persistence.** Every candidate is written to `anomaly_candidates` (not just preserved events) so the aggregate test has data.
   - Strong, seedable, well-coupled hours are **preserved** at full resolution; everything else is compacted to hourly summaries.

Daily (`run-aggregate.js`): rebuild the **airframe ranking** (`aggregate.js`) — for each airframe, how many seedable anomalies it was a strong candidate for vs. what its flight volume predicts, via a flight-volume-weighted **permutation null** with **Benjamini–Hochberg FDR** correction.

---

## Quick start

```bash
git clone https://github.com/YOUR_USERNAME/cloudseeding-collector.git
cd cloudseeding-collector
npm install
cp .env.example .env          # add OpenSky credentials (recommended)
node setup-db.js              # create / migrate the database
node fetch-faa-seeders.js     # build the known-seeder registry (see below)
node collect.js               # run one cycle
node collect-loop.js          # or run continuously
```

### Build the known-seeder registry

`seeders.js` matches live aircraft by icao24, so the registry must be populated:

```bash
node fetch-faa-seeders.js
```

This downloads the public **FAA Releasable Aircraft Database**, keeps rows whose registered owner matches a weather-modification operator pattern (edit `data/operators.json` — add operators named in NOAA weather-modification reports filed under 15 U.S.C. §330), reads the **Mode S / ICAO hex directly** from the FAA data, and writes them into `seeder_registry` + `data/seeders.json`. Re-run monthly. (If your host can't reach `registry.faa.gov`, download the zip in a browser and run `node fetch-faa-seeders.js ./ReleasableAircraft.zip`.)

---

## API server

Read-only REST over the database. **All v1 endpoints are unchanged** (the website keeps working); new ones expose the layered output.

```bash
node serve.js                 # default port 4000
```

| Endpoint | Description |
|---|---|
| `GET /api/correlate?lat=&lng=&hours=24` | **(v1)** weather + per-hour flight counts — the dashboard uses this |
| `GET /api/flights?lat=&lng=&hours=48` | **(v1)** recent seeding-band detail |
| `GET /api/flights/history?lat=&lng=&days=30` | **(v1)** compacted hourly flight data |
| `GET /api/weather` · `/api/seeders` · `/api/traffic` · `/api/events` · `/api/events/:id` · `/api/stats` | **(v1)** unchanged |
| `GET /api/anomalies?days=30&seedable=0.4` | **(new)** forecast-exceedance anomalies (optionally seedable-gated, geo-boxed) |
| `GET /api/anomalies/:id` | **(new)** one anomaly + its ranked candidate aircraft |
| `GET /api/candidates?icao24=ab1234` | **(new)** an airframe's wind-coupling history (or top recent) |
| `GET /api/airframes?significant=1` | **(new, headline)** the repeat-offender ranking |
| `GET /api/seeders/registry` | **(new)** the icao24-keyed known-seeder list |

`/api/airframes` is the one to watch: airframes sorted by **associations beyond flight-volume expectation**. `significant=1` filters to those passing the FDR threshold.

---

## Real observations vs. model data (important)

The anomaly detector asks one question — *"what were the actual conditions this hour?"* — through a pluggable adapter (`sources/observations.js`):

- **`OBSERVATION_SOURCE=openmeteo` (default, fully runnable):** uses the Open-Meteo grid. This is a **forecast model's best estimate, not observation.** It works out of the box and makes the whole pipeline run, but the "actual" side is still model data, which limits anomaly fidelity.
- **`OBSERVATION_SOURCE=mrms` / `goes` (recommended upgrade):** real radar (MRMS QPE) / satellite (GOES ABI cloud-top temperature). These are GRIB2/NetCDF formats that need the scientific Python stack, which doesn't belong in this Node service — so they're served by a small **HTTP sidecar** at `OBSERVATION_SIDECAR_URL` returning the same normalized cells. The analysis, coupling, and aggregation code is unchanged; it's a config flip once the sidecar is up. (GOES cloud-top temperature also makes the **seedability gate** far sharper — with model data it falls back to a documented proxy from freezing level + cloud + humidity.)

---

## Warm-up & limitations (read before trusting output)

- **Baseline warm-up.** The forecast counterfactual needs a few hours of persisted forecasts before it engages; until then anomalies use hour-over-hour persistence (noisier).
- **Aggregate power.** The repeat-offender test has little power until *many* seedable anomalies accumulate (weeks). Early rankings are indicative, not conclusive.
- **Candidates, not conclusions.** Atmospheric-research, survey, pipeline-patrol, and traffic aircraft can rank high and must be ruled out by a human. A high rank is a *reason to look*, nothing more.
- **Coarse grid.** The 2° weather grid is a synoptic baseline only; real plume-scale structure needs the observation sidecar.
- **Model wind.** Upwind backtracking uses model wind; good enough for ~tens-of-km advection over a few hours, not exact.

---

## Configuration

Everything is in `config.js`, overridable via env (see `.env.example`). Highlights:

| Variable | Default | Description |
|---|---|---|
| `DB_PATH` | `./cloudseeding.db` | SQLite file (Railway: the mounted volume) |
| `OPENSKY_CLIENT_ID` / `_SECRET` | — | OAuth2 creds; **set these to stop the 429s** |
| `OBSERVATION_SOURCE` | `openmeteo` | `openmeteo` \| `mrms` \| `goes` |
| `OBSERVATION_SIDECAR_URL` | — | sidecar for `mrms`/`goes` |
| `SEED_ALT_MIN` / `_MAX` | `5000` / `14000` | altitude band the analysis trusts |
| `FORECAST_HORIZON_HOURS` | `12` | how far ahead forecasts are persisted |
| `AGGREGATE_PERMUTATIONS` | `500` | permutation null iterations |
| `AGGREGATE_FDR_ALPHA` | `0.1` | FDR significance threshold |
| `COLLECT_INTERVAL_MS` | `300000` | collection cadence |

---

## Maintenance & schema

- `node monitor.js [--vacuum]` — storage vitals + in-place page reclaim (safe under a tight volume cap; avoids a full VACUUM's ~2× scratch need). The loop runs this + the aggregate daily.
- `node reset-preservation.js` — wipe **derived** tables (events + anomalies + candidates + airframe scores) to let the new detector rebuild; raw inputs and the registry are untouched.
- The schema lives in one place (`schema.js`); `setup-db.js` and the reset script compose from it, so create/reset can't drift. New databases set `auto_vacuum=INCREMENTAL`; existing ones are migrated (e.g. `weather_grid.freezing_level_m` is added in place).

```
RAW (48h rolling):     flights_seeding_alt
FOREVER:               weather_grid, weather_forecast, seeder_tracks,
                       flight_hourly_detail, traffic_hourly_summary, seeder_registry
DERIVED (rebuildable): weather_anomalies, anomaly_candidates,
                       preservation_events, preserved_flight_detail, airframe_scores
```

---

## Data sources & attribution

- **Flights:** [OpenSky Network](https://opensky-network.org/) (*Schäfer et al., IPSN 2014*) and [airplanes.live](https://airplanes.live/).
- **Weather:** [Open-Meteo](https://open-meteo.com/) (CC BY 4.0). Optional real observations: NOAA **MRMS**, **GOES-16/18 ABI**.
- **Known seeders:** FAA Releasable Aircraft Database (public) + operators named in NOAA weather-modification activity reports (15 U.S.C. §330).

## License

MIT — see [LICENSE](LICENSE).
