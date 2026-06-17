#!/usr/bin/env node
// ─── DATABASE SETUP ─────────────────────────────────────────────────────────
// Run once: node setup-db.js
// Creates the SQLite database and tables for CONUS-wide collection.

const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "cloudseeding.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  -- ═══════════════════════════════════════════════════════════════════════════
  -- WEATHER: Grid-based coverage of entire CONUS
  -- 2° grid spacing ≈ 13 lat × 30 lng = ~195 grid points
  -- Queried hourly from Open-Meteo. ~30 KB/hour → ~700 KB/day → 260 MB/year
  -- KEPT FOREVER.
  -- ═══════════════════════════════════════════════════════════════════════════

  CREATE TABLE IF NOT EXISTS weather_grid (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    grid_lat REAL NOT NULL,           -- grid point latitude (2° resolution)
    grid_lng REAL NOT NULL,           -- grid point longitude
    timestamp TEXT NOT NULL,          -- ISO 8601 hour
    temperature REAL,
    humidity REAL,
    wind_speed REAL,
    wind_dir REAL,
    precip_rate REAL,
    precip_prob REAL,
    cloud_cover REAL,
    cloud_cover_low REAL,
    cloud_cover_mid REAL,
    cloud_cover_high REAL,
    pressure REAL,
    dewpoint REAL,
    visibility REAL,
    UNIQUE(grid_lat, grid_lng, timestamp)
  );

  -- ═══════════════════════════════════════════════════════════════════════════
  -- FLIGHTS: Full CONUS pull, filtered by altitude
  --
  -- Seeding altitude band (5,000–30,000 ft) = stored in FULL DETAIL.
  -- These are the correlation candidates — known AND unknown seeders.
  -- Above 30,000 ft = commercial traffic, counted but not individually stored.
  --
  -- Rolling 48h full detail → compacted to hourly per-aircraft summaries.
  -- ═══════════════════════════════════════════════════════════════════════════

  -- Full-detail positions for seeding-altitude aircraft (48h rolling)
  CREATE TABLE IF NOT EXISTS flights_seeding_alt (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_time TEXT NOT NULL,
    icao24 TEXT,
    callsign TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    altitude_ft REAL,
    speed_kts REAL,
    heading REAL,
    vertical_rate REAL,               -- ft/min, for pattern detection
    squawk TEXT,
    is_known_seeder INTEGER DEFAULT 0,
    operator TEXT,
    aircraft_type TEXT,
    on_ground INTEGER DEFAULT 0
  );

  -- Known seeder tracks — EVERY position, FOREVER
  CREATE TABLE IF NOT EXISTS seeder_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_time TEXT NOT NULL,
    icao24 TEXT,
    callsign TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    altitude_ft REAL,
    speed_kts REAL,
    heading REAL,
    vertical_rate REAL,
    squawk TEXT,
    operator TEXT,
    aircraft_type TEXT
  );

  -- Compacted hourly summaries: one row per callsign per hour
  -- "Aircraft N350WM was seen between 14:00-15:00, positions X→Y, alt range A-B"
  -- KEPT FOREVER. This is the long-term correlation dataset.
  CREATE TABLE IF NOT EXISTS flight_hourly_detail (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hour TEXT NOT NULL,                -- ISO truncated to hour
    callsign TEXT NOT NULL,
    icao24 TEXT,
    is_known_seeder INTEGER DEFAULT 0,
    operator TEXT,
    aircraft_type TEXT,
    -- Position envelope for this hour
    min_lat REAL, max_lat REAL,
    min_lng REAL, max_lng REAL,
    avg_lat REAL, avg_lng REAL,
    min_alt_ft REAL, max_alt_ft REAL,
    avg_alt_ft REAL,
    avg_speed_kts REAL,
    avg_heading REAL,
    sightings INTEGER DEFAULT 1,      -- how many polls saw this aircraft
    UNIQUE(hour, callsign)
  );

  -- CONUS-wide per-hour traffic summary (all altitudes)
  CREATE TABLE IF NOT EXISTS traffic_hourly_summary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hour TEXT NOT NULL,
    total_aircraft INTEGER DEFAULT 0,
    seeding_alt_aircraft INTEGER DEFAULT 0,  -- 5k-30k ft
    high_alt_aircraft INTEGER DEFAULT 0,     -- >30k ft (commercial)
    low_alt_aircraft INTEGER DEFAULT 0,      -- <5k ft
    known_seeder_count INTEGER DEFAULT 0,
    known_seeder_callsigns TEXT,             -- comma-separated
    UNIQUE(hour)
  );

  -- ═══════════════════════════════════════════════════════════════════════════
  -- INDEXES
  -- ═══════════════════════════════════════════════════════════════════════════

  CREATE INDEX IF NOT EXISTS idx_weather_grid_ts ON weather_grid(grid_lat, grid_lng, timestamp);
  CREATE INDEX IF NOT EXISTS idx_weather_ts ON weather_grid(timestamp);
  CREATE INDEX IF NOT EXISTS idx_fsa_poll ON flights_seeding_alt(poll_time);
  CREATE INDEX IF NOT EXISTS idx_fsa_callsign ON flights_seeding_alt(callsign);
  CREATE INDEX IF NOT EXISTS idx_fsa_seeder ON flights_seeding_alt(is_known_seeder);
  CREATE INDEX IF NOT EXISTS idx_fsa_pos ON flights_seeding_alt(lat, lng);
  CREATE INDEX IF NOT EXISTS idx_seeder_poll ON seeder_tracks(poll_time);
  CREATE INDEX IF NOT EXISTS idx_seeder_cs ON seeder_tracks(callsign);
  CREATE INDEX IF NOT EXISTS idx_fhd_hour ON flight_hourly_detail(hour);
  CREATE INDEX IF NOT EXISTS idx_fhd_cs ON flight_hourly_detail(callsign);
  CREATE INDEX IF NOT EXISTS idx_fhd_seeder ON flight_hourly_detail(is_known_seeder, hour);
  CREATE INDEX IF NOT EXISTS idx_fhd_pos ON flight_hourly_detail(avg_lat, avg_lng);
  CREATE INDEX IF NOT EXISTS idx_traffic_hour ON traffic_hourly_summary(hour);

  -- ═══════════════════════════════════════════════════════════════════════════
  -- EVENT-TRIGGERED PRESERVATION
  --
  -- When the compaction step detects seeding-indicative patterns in an hour,
  -- the full 5-minute-resolution flight data is preserved permanently instead
  -- of being discarded. This is how you trace a specific aircraft responsible.
  --
  -- Detection signals:
  --   • Loiter pattern: aircraft with ≥6 sightings/hr but <0.3° geo spread
  --     (racetrack/orbit = seeding flight profile vs commercial fly-through)
  --   • Known seeder callsign present at any altitude
  --   • Weather correlation: cloud cover spike or precip onset at nearby grid
  --   • Cluster: multiple seeding-alt aircraft converging in same area
  --
  -- A context window of ±2 hours is also preserved so analysts can see
  -- what happened leading up to and following the event.
  -- ═══════════════════════════════════════════════════════════════════════════

  -- Full-resolution flight data for hours flagged by the correlation engine.
  -- Same schema as flights_seeding_alt. KEPT FOREVER.
  -- Typical size: ~50-200 MB/year (events are rare, but when they happen
  -- you get every 5-minute position for every aircraft in the area).
  CREATE TABLE IF NOT EXISTS preserved_flight_detail (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,           -- links to preservation_events
    poll_time TEXT NOT NULL,
    icao24 TEXT,
    callsign TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    altitude_ft REAL,
    speed_kts REAL,
    heading REAL,
    vertical_rate REAL,
    squawk TEXT,
    is_known_seeder INTEGER DEFAULT 0,
    operator TEXT,
    aircraft_type TEXT,
    FOREIGN KEY (event_id) REFERENCES preservation_events(id)
  );

  -- Log of why each preservation was triggered.
  CREATE TABLE IF NOT EXISTS preservation_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    detected_at TEXT DEFAULT (datetime('now')),
    hour TEXT NOT NULL,                  -- the hour that triggered preservation
    context_start TEXT NOT NULL,         -- earliest hour preserved (hour - 2h)
    context_end TEXT NOT NULL,           -- latest hour preserved (hour + 1h)
    center_lat REAL,                     -- event location (centroid of loiters)
    center_lng REAL,                     -- used to bound preservation geographically
    radius_deg REAL DEFAULT 1.0,         -- preservation box half-width in degrees
    score INTEGER NOT NULL,             -- composite signal score
    -- Signal breakdown
    known_seeder_present INTEGER DEFAULT 0,
    loiter_callsigns TEXT,              -- comma-separated: aircraft flagged as loitering
    loiter_count INTEGER DEFAULT 0,
    cloud_delta_max REAL DEFAULT 0,     -- max cloud increase at nearby grid points
    precip_onset INTEGER DEFAULT 0,     -- 1 if precip started at nearby grid points
    cluster_count INTEGER DEFAULT 0,    -- number of converging aircraft groups
    -- Summary
    total_aircraft_preserved INTEGER DEFAULT 0,
    total_rows_preserved INTEGER DEFAULT 0,
    reason TEXT                          -- human-readable summary
  );

  CREATE INDEX IF NOT EXISTS idx_pfd_event ON preserved_flight_detail(event_id);
  CREATE INDEX IF NOT EXISTS idx_pfd_poll ON preserved_flight_detail(poll_time);
  CREATE INDEX IF NOT EXISTS idx_pfd_cs ON preserved_flight_detail(callsign);
  CREATE INDEX IF NOT EXISTS idx_pfd_pos ON preserved_flight_detail(lat, lng);
  CREATE INDEX IF NOT EXISTS idx_pe_hour ON preservation_events(hour);
  CREATE INDEX IF NOT EXISTS idx_pe_score ON preservation_events(score);
  -- Guards that prevent the duplication/re-preservation bug from recurring
  CREATE UNIQUE INDEX IF NOT EXISTS uq_pe_hour ON preservation_events(hour);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_pfd_logical
    ON preserved_flight_detail(event_id, poll_time, icao24, callsign);
`);

console.log(`Database ready at: ${DB_PATH}`);

// Show CONUS weather grid info
const CONUS = { latMin: 24, latMax: 50, lngMin: -125, lngMax: -66 };
const gridStep = 2;
let gridPoints = 0;
for (let lat = CONUS.latMin; lat <= CONUS.latMax; lat += gridStep) {
  for (let lng = CONUS.lngMin; lng <= CONUS.lngMax; lng += gridStep) {
    gridPoints++;
  }
}
console.log(`Weather grid: ${gridPoints} points at ${gridStep}° spacing across CONUS`);
console.log(`CONUS bbox: ${CONUS.latMin}–${CONUS.latMax}°N, ${CONUS.lngMin}–${CONUS.lngMax}°W`);
console.log(`\nEstimated daily storage:`);
console.log(`  Weather:  ~${Math.round(gridPoints * 24 * 0.15)} KB/day (${gridPoints} pts × 24h × 150 bytes)`);
console.log(`  Flights:  ~50-100 MB/day rolling (48h window, seeding alt only)`);
console.log(`  Summaries: ~${Math.round(2000 * 24 * 0.12 / 1024)} MB/day compacted (all seeding-alt callsigns)`);
console.log(`  Seeders:  ~few KB/day (permanent track data)`);
console.log(`  Yearly total (compacted): ~500 MB–1 GB`);

db.close();
