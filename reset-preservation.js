#!/usr/bin/env node
// ─── RESET PRESERVATION TABLES ────────────────────────────────────────────────
// The preservation detector fired on national air-traffic noise: all 1,577
// events are false positives (0 had a real known seeder), and preserved_flight_
// detail holds ~24M rows that are just snapshots of all CONUS aircraft. There is
// no signal to keep. This wipes both tables and reclaims the space.
//
// Safe because: we are emptying entire tables, not selectively deleting, so there
// is no large rollback/WAL growth. We recreate them empty with the CORRECT
// schema (incl. lat/lng on events + UNIQUE guards) so the fixed detector can
// rebuild legitimately.
//
// Usage (inside the container, from /app):
//   node reset-preservation.js --dry-run
//   node reset-preservation.js

const Database = require("better-sqlite3");
const fs = require("fs");

const DB_PATH = process.env.DB_PATH || "/app/data/cloudseeding.db";
const DRY = process.argv.includes("--dry-run");
const gb = (b) => (b / 1024 / 1024 / 1024).toFixed(2) + " GB";
const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

const db = new Database(DB_PATH, { timeout: 120000 });
const n = (s) => db.prepare(s).get().n;

const ev = n("SELECT COUNT(*) n FROM preservation_events");
const pf = n("SELECT COUNT(*) n FROM preserved_flight_detail");
console.log(`\nTarget: ${DB_PATH}  (${gb(sizeOf(DB_PATH))})`);
console.log(`preservation_events:     ${ev.toLocaleString()}`);
console.log(`preserved_flight_detail: ${pf.toLocaleString()}`);

if (DRY) {
  console.log("\nDRY RUN — would drop and recreate both tables empty, then VACUUM.");
  db.close();
  process.exit(0);
}

console.log("\nDropping bogus preservation tables...");
db.exec(`
  DROP TABLE IF EXISTS preserved_flight_detail;
  DROP TABLE IF EXISTS preservation_events;
`);

console.log("Recreating empty with corrected schema...");
db.exec(`
  CREATE TABLE preservation_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    detected_at TEXT DEFAULT (datetime('now')),
    hour TEXT NOT NULL,
    context_start TEXT NOT NULL,
    context_end TEXT NOT NULL,
    -- NEW: where the event was, so context can be filtered geographically
    center_lat REAL,
    center_lng REAL,
    radius_deg REAL DEFAULT 1.0,
    score INTEGER NOT NULL,
    known_seeder_present INTEGER DEFAULT 0,
    loiter_callsigns TEXT,
    loiter_count INTEGER DEFAULT 0,
    cloud_delta_max REAL DEFAULT 0,
    precip_onset INTEGER DEFAULT 0,
    cluster_count INTEGER DEFAULT 0,
    total_aircraft_preserved INTEGER DEFAULT 0,
    total_rows_preserved INTEGER DEFAULT 0,
    reason TEXT
  );
  CREATE UNIQUE INDEX uq_pe_hour ON preservation_events(hour);
  CREATE INDEX idx_pe_score ON preservation_events(score);

  CREATE TABLE preserved_flight_detail (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
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
  CREATE INDEX idx_pfd_event ON preserved_flight_detail(event_id);
  CREATE INDEX idx_pfd_poll  ON preserved_flight_detail(poll_time);
  CREATE INDEX idx_pfd_cs    ON preserved_flight_detail(callsign);
  CREATE INDEX idx_pfd_pos   ON preserved_flight_detail(lat, lng);
  CREATE UNIQUE INDEX uq_pfd_logical
    ON preserved_flight_detail(event_id, poll_time, icao24, callsign);
`);

console.log("VACUUM (reclaiming space)...");
db.pragma("auto_vacuum = INCREMENTAL");
db.exec("VACUUM");
db.pragma("wal_checkpoint(TRUNCATE)");

db.close();
console.log(`\n✓ Done. DB now ${gb(sizeOf(DB_PATH))}. Both tables empty with corrected schema.`);
console.log(`  Deploy the fixed collect.js so the detector rebuilds events correctly.\n`);
