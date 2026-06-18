#!/usr/bin/env node
// ─── DATABASE SETUP ─────────────────────────────────────────────────────────
// Run once (idempotent): node setup-db.js
//
// Backward compatible: every table the website/serve.js reads is kept. New tables
// (weather_forecast, weather_anomalies, anomaly_candidates, airframe_scores,
// seeder_registry) power the layered detector. DDL lives in schema.js so "create"
// and "reset" can never drift apart.

const Database = require("better-sqlite3");
const cfg = require("./config");
const schema = require("./schema");

const db = new Database(cfg.DB_PATH);
// Enable in-place reclaim on FRESH databases (no effect on existing ones without
// a one-time VACUUM; monitor.js handles that). Must precede table creation.
try { db.pragma("auto_vacuum = INCREMENTAL"); } catch {}
db.pragma("journal_mode = WAL");

db.exec(schema.tablesSQL());
db.exec(schema.indexesSQL());

// ── Migrations for pre-existing databases ──
function ensureColumn(table, col, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    console.log(`  migrated: added ${table}.${col}`);
  }
}
ensureColumn("weather_grid", "freezing_level_m", "REAL");
ensureColumn("flights_seeding_alt", "on_ground", "INTEGER DEFAULT 0");

// ── Report ──
console.log(`Database ready at: ${cfg.DB_PATH}`);
let gridPoints = 0;
for (let lat = cfg.CONUS.latMin; lat <= cfg.CONUS.latMax; lat += cfg.WEATHER_GRID_STEP)
  for (let lng = cfg.CONUS.lngMin; lng <= cfg.CONUS.lngMax; lng += cfg.WEATHER_GRID_STEP) gridPoints++;
console.log(`Weather grid: ${gridPoints} points at ${cfg.WEATHER_GRID_STEP}° spacing across CONUS`);
console.log(`CONUS bbox: ${cfg.CONUS.latMin}–${cfg.CONUS.latMax}°N, ${cfg.CONUS.lngMin}–${cfg.CONUS.lngMax}°W`);
console.log(`Seeding band trusted by analysis: ${cfg.SEED_ALT_MIN}–${cfg.SEED_ALT_MAX} ft`);
console.log(`Observation source: ${cfg.SOURCES.observationSource}  |  forecast horizon: ${cfg.FORECAST_HORIZON_HOURS}h`);

db.close();
