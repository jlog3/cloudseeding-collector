#!/usr/bin/env node
// ─── RESET DERIVED ANALYSIS TABLES ────────────────────────────────────────────
// Wipes the DERIVED detector output so the reworked, layered detector can rebuild
// from scratch. Does NOT touch raw inputs (weather_grid, weather_forecast,
// flights_seeding_alt, seeder_tracks, flight_hourly_detail, traffic) or the
// seeder_registry. Use after deploying v2, or to clear false positives from the
// old aircraft-first detector.
//
// Resets: preservation_events, preserved_flight_detail, weather_anomalies,
//         anomaly_candidates, airframe_scores.
//
//   node reset-preservation.js --dry-run
//   node reset-preservation.js

const Database = require("better-sqlite3");
const fs = require("fs");
const cfg = require("./config");
const schema = require("./schema");

const RESET_TABLES = [
  "preservation_events", "preserved_flight_detail",
  "weather_anomalies", "anomaly_candidates", "airframe_scores",
];

const DB_PATH = cfg.DB_PATH;
const DRY = process.argv.includes("--dry-run");
const gb = (b) => (b / 1024 / 1024 / 1024).toFixed(2) + " GB";
const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

const db = new Database(DB_PATH, { timeout: 120000 });
const n = (s) => { try { return db.prepare(s).get().n; } catch { return 0; } };

const counts = {
  preservation_events: n("SELECT COUNT(*) n FROM preservation_events"),
  preserved_flight_detail: n("SELECT COUNT(*) n FROM preserved_flight_detail"),
  weather_anomalies: n("SELECT COUNT(*) n FROM weather_anomalies"),
  anomaly_candidates: n("SELECT COUNT(*) n FROM anomaly_candidates"),
  airframe_scores: n("SELECT COUNT(*) n FROM airframe_scores"),
};
console.log(`\nTarget: ${DB_PATH}  (${gb(sizeOf(DB_PATH))})`);
for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(24)} ${v.toLocaleString()}`);

if (DRY) { console.log("\nDRY RUN — would drop & recreate these tables empty, then reclaim space."); db.close(); process.exit(0); }

console.log("\nDropping derived analysis tables...");
db.exec(`
  DROP TABLE IF EXISTS preserved_flight_detail;
  DROP TABLE IF EXISTS preservation_events;
  DROP TABLE IF EXISTS anomaly_candidates;
  DROP TABLE IF EXISTS weather_anomalies;
  DROP TABLE IF EXISTS airframe_scores;
`);

console.log("Recreating empty with current schema (from schema.js)...");
db.exec(schema.tablesSQL(RESET_TABLES));
db.exec(schema.indexesSQL(RESET_TABLES));

console.log("Reclaiming space (incremental)...");
db.pragma("auto_vacuum = INCREMENTAL");
try { db.pragma("incremental_vacuum"); } catch {}
db.pragma("wal_checkpoint(TRUNCATE)");

db.close();
console.log(`\n✓ Done. DB now ${gb(sizeOf(DB_PATH))}. Derived tables empty; raw inputs + registry untouched.`);
console.log(`  Next collection cycle will rebuild anomalies/candidates; run-aggregate rebuilds the ranking.\n`);
