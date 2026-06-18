// ─── SCHEMA (single source of truth) ────────────────────────────────────────
// Both setup-db.js and reset-preservation.js compose their DDL from here so the
// schema can never drift between "create" and "reset", and so it can be validated
// independently. All CREATEs are IF NOT EXISTS / additive.

const TABLE = {
  // ── Raw inputs / forever tables (backward compatible with the website) ──
  weather_grid: `
    CREATE TABLE IF NOT EXISTS weather_grid (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grid_lat REAL NOT NULL, grid_lng REAL NOT NULL, timestamp TEXT NOT NULL,
      temperature REAL, humidity REAL, wind_speed REAL, wind_dir REAL,
      precip_rate REAL, precip_prob REAL,
      cloud_cover REAL, cloud_cover_low REAL, cloud_cover_mid REAL, cloud_cover_high REAL,
      pressure REAL, dewpoint REAL, visibility REAL, freezing_level_m REAL,
      UNIQUE(grid_lat, grid_lng, timestamp)
    )`,

  flights_seeding_alt: `
    CREATE TABLE IF NOT EXISTS flights_seeding_alt (
      id INTEGER PRIMARY KEY AUTOINCREMENT, poll_time TEXT NOT NULL,
      icao24 TEXT, callsign TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
      altitude_ft REAL, speed_kts REAL, heading REAL, vertical_rate REAL,
      squawk TEXT, is_known_seeder INTEGER DEFAULT 0,
      operator TEXT, aircraft_type TEXT, on_ground INTEGER DEFAULT 0
    )`,

  seeder_tracks: `
    CREATE TABLE IF NOT EXISTS seeder_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, poll_time TEXT NOT NULL,
      icao24 TEXT, callsign TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
      altitude_ft REAL, speed_kts REAL, heading REAL, vertical_rate REAL,
      squawk TEXT, operator TEXT, aircraft_type TEXT
    )`,

  flight_hourly_detail: `
    CREATE TABLE IF NOT EXISTS flight_hourly_detail (
      id INTEGER PRIMARY KEY AUTOINCREMENT, hour TEXT NOT NULL, callsign TEXT NOT NULL, icao24 TEXT,
      is_known_seeder INTEGER DEFAULT 0, operator TEXT, aircraft_type TEXT,
      min_lat REAL, max_lat REAL, min_lng REAL, max_lng REAL, avg_lat REAL, avg_lng REAL,
      min_alt_ft REAL, max_alt_ft REAL, avg_alt_ft REAL, avg_speed_kts REAL, avg_heading REAL,
      sightings INTEGER DEFAULT 1, UNIQUE(hour, callsign)
    )`,

  traffic_hourly_summary: `
    CREATE TABLE IF NOT EXISTS traffic_hourly_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT, hour TEXT NOT NULL,
      total_aircraft INTEGER DEFAULT 0, seeding_alt_aircraft INTEGER DEFAULT 0,
      high_alt_aircraft INTEGER DEFAULT 0, low_alt_aircraft INTEGER DEFAULT 0,
      known_seeder_count INTEGER DEFAULT 0, known_seeder_callsigns TEXT, UNIQUE(hour)
    )`,

  preservation_events: `
    CREATE TABLE IF NOT EXISTS preservation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, detected_at TEXT DEFAULT (datetime('now')),
      hour TEXT NOT NULL, context_start TEXT NOT NULL, context_end TEXT NOT NULL,
      center_lat REAL, center_lng REAL, radius_deg REAL DEFAULT 1.0, score INTEGER NOT NULL,
      known_seeder_present INTEGER DEFAULT 0, loiter_callsigns TEXT, loiter_count INTEGER DEFAULT 0,
      cloud_delta_max REAL DEFAULT 0, precip_onset INTEGER DEFAULT 0, cluster_count INTEGER DEFAULT 0,
      total_aircraft_preserved INTEGER DEFAULT 0, total_rows_preserved INTEGER DEFAULT 0, reason TEXT
    )`,

  preserved_flight_detail: `
    CREATE TABLE IF NOT EXISTS preserved_flight_detail (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, poll_time TEXT NOT NULL,
      icao24 TEXT, callsign TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
      altitude_ft REAL, speed_kts REAL, heading REAL, vertical_rate REAL, squawk TEXT,
      is_known_seeder INTEGER DEFAULT 0, operator TEXT, aircraft_type TEXT,
      FOREIGN KEY (event_id) REFERENCES preservation_events(id)
    )`,

  // ── New: layered detector ──
  weather_forecast: `
    CREATE TABLE IF NOT EXISTS weather_forecast (
      id INTEGER PRIMARY KEY AUTOINCREMENT, grid_lat REAL NOT NULL, grid_lng REAL NOT NULL,
      target_hour TEXT NOT NULL, issued_at TEXT NOT NULL,
      cloud_cover REAL, precip_rate REAL, precip_prob REAL,
      UNIQUE(grid_lat, grid_lng, target_hour, issued_at)
    )`,

  weather_anomalies: `
    CREATE TABLE IF NOT EXISTS weather_anomalies (
      id INTEGER PRIMARY KEY AUTOINCREMENT, detected_at TEXT DEFAULT (datetime('now')),
      hour TEXT NOT NULL, center_lat REAL, center_lng REAL, cell_count INTEGER,
      cloud_excess_max REAL, precip_excess_max REAL, precip_onset INTEGER DEFAULT 0,
      elongation REAL, seedable_frac REAL, wind_speed REAL, wind_dir REAL,
      baseline_kind TEXT, magnitude REAL
    )`,

  anomaly_candidates: `
    CREATE TABLE IF NOT EXISTS anomaly_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, anomaly_id INTEGER NOT NULL, hour TEXT NOT NULL,
      icao24 TEXT, callsign TEXT, operator TEXT, aircraft_type TEXT, is_known_seeder INTEGER DEFAULT 0,
      score REAL, best_lag_hours REAL, coupling_km REAL, avg_alt_ft REAL, avg_speed_kts REAL,
      straightness REAL, is_racetrack INTEGER DEFAULT 0, is_straight_pass INTEGER DEFAULT 0,
      perpendicularity REAL, sightings INTEGER,
      FOREIGN KEY (anomaly_id) REFERENCES weather_anomalies(id)
    )`,

  airframe_scores: `
    CREATE TABLE IF NOT EXISTS airframe_scores (
      icao24 TEXT PRIMARY KEY, callsign TEXT, operator TEXT, aircraft_type TEXT,
      is_known_seeder INTEGER DEFAULT 0, associations INTEGER, expected REAL, excess REAL,
      z REAL, p_value REAL, fdr_q REAL, significant INTEGER DEFAULT 0,
      active_hours INTEGER, mean_candidate_score REAL, updated_at TEXT
    )`,

  seeder_registry: `
    CREATE TABLE IF NOT EXISTS seeder_registry (
      icao24 TEXT PRIMARY KEY, registration TEXT, operator TEXT, aircraft_type TEXT,
      source TEXT, added_at TEXT DEFAULT (datetime('now'))
    )`,
};

const INDEX = {
  weather_grid: [
    "CREATE INDEX IF NOT EXISTS idx_weather_grid_ts ON weather_grid(grid_lat, grid_lng, timestamp)",
    "CREATE INDEX IF NOT EXISTS idx_weather_ts ON weather_grid(timestamp)",
  ],
  flights_seeding_alt: [
    "CREATE INDEX IF NOT EXISTS idx_fsa_poll ON flights_seeding_alt(poll_time)",
    "CREATE INDEX IF NOT EXISTS idx_fsa_callsign ON flights_seeding_alt(callsign)",
    "CREATE INDEX IF NOT EXISTS idx_fsa_icao ON flights_seeding_alt(icao24)",
    "CREATE INDEX IF NOT EXISTS idx_fsa_seeder ON flights_seeding_alt(is_known_seeder)",
    "CREATE INDEX IF NOT EXISTS idx_fsa_pos ON flights_seeding_alt(lat, lng)",
    "CREATE INDEX IF NOT EXISTS idx_fsa_poll_pos ON flights_seeding_alt(poll_time, lat, lng)",
  ],
  seeder_tracks: [
    "CREATE INDEX IF NOT EXISTS idx_seeder_poll ON seeder_tracks(poll_time)",
    "CREATE INDEX IF NOT EXISTS idx_seeder_icao ON seeder_tracks(icao24)",
  ],
  flight_hourly_detail: [
    "CREATE INDEX IF NOT EXISTS idx_fhd_hour ON flight_hourly_detail(hour)",
    "CREATE INDEX IF NOT EXISTS idx_fhd_cs ON flight_hourly_detail(callsign)",
    "CREATE INDEX IF NOT EXISTS idx_fhd_icao ON flight_hourly_detail(icao24, hour)",
    "CREATE INDEX IF NOT EXISTS idx_fhd_seeder ON flight_hourly_detail(is_known_seeder, hour)",
    "CREATE INDEX IF NOT EXISTS idx_fhd_pos ON flight_hourly_detail(avg_lat, avg_lng)",
  ],
  traffic_hourly_summary: [
    "CREATE INDEX IF NOT EXISTS idx_traffic_hour ON traffic_hourly_summary(hour)",
  ],
  preserved_flight_detail: [
    "CREATE INDEX IF NOT EXISTS idx_pfd_event ON preserved_flight_detail(event_id)",
    "CREATE INDEX IF NOT EXISTS idx_pfd_poll ON preserved_flight_detail(poll_time)",
    "CREATE INDEX IF NOT EXISTS idx_pfd_cs ON preserved_flight_detail(callsign)",
    "CREATE INDEX IF NOT EXISTS idx_pfd_pos ON preserved_flight_detail(lat, lng)",
  ],
  preservation_events: [
    "CREATE INDEX IF NOT EXISTS idx_pe_hour ON preservation_events(hour)",
    "CREATE INDEX IF NOT EXISTS idx_pe_score ON preservation_events(score)",
  ],
  weather_forecast: [
    "CREATE INDEX IF NOT EXISTS idx_wf_target ON weather_forecast(grid_lat, grid_lng, target_hour)",
    "CREATE INDEX IF NOT EXISTS idx_wf_issued ON weather_forecast(issued_at)",
  ],
  weather_anomalies: [
    "CREATE INDEX IF NOT EXISTS idx_wa_hour ON weather_anomalies(hour)",
    "CREATE INDEX IF NOT EXISTS idx_wa_pos ON weather_anomalies(center_lat, center_lng)",
    "CREATE INDEX IF NOT EXISTS idx_wa_seedable ON weather_anomalies(seedable_frac)",
  ],
  anomaly_candidates: [
    "CREATE INDEX IF NOT EXISTS idx_ac_anomaly ON anomaly_candidates(anomaly_id)",
    "CREATE INDEX IF NOT EXISTS idx_ac_icao ON anomaly_candidates(icao24)",
    "CREATE INDEX IF NOT EXISTS idx_ac_hour ON anomaly_candidates(hour)",
    "CREATE INDEX IF NOT EXISTS idx_ac_score ON anomaly_candidates(score)",
  ],
  airframe_scores: [
    "CREATE INDEX IF NOT EXISTS idx_as_excess ON airframe_scores(excess)",
    "CREATE INDEX IF NOT EXISTS idx_as_q ON airframe_scores(fdr_q)",
  ],
  seeder_registry: [
    "CREATE INDEX IF NOT EXISTS idx_sr_operator ON seeder_registry(operator)",
  ],
};

// Guards that prevent the historical duplication / re-preservation bug.
const GUARD_INDEX = [
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_pe_hour ON preservation_events(hour)",
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_pfd_logical ON preserved_flight_detail(event_id, poll_time, icao24, callsign)",
];

function tablesSQL(names = Object.keys(TABLE)) {
  return names.map((n) => TABLE[n]).join(";\n") + ";";
}
function indexesSQL(names = Object.keys(TABLE)) {
  const idx = names.flatMap((n) => INDEX[n] || []);
  return [...idx, ...GUARD_INDEX].join(";\n") + ";";
}

module.exports = { TABLE, INDEX, GUARD_INDEX, tablesSQL, indexesSQL };
