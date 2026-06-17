#!/usr/bin/env node
// ─── ONE-TIME PRESERVATION DEDUP + RETENTION ──────────────────────────────────
// Recovers from the preservation duplication bug (the same interesting hour was
// re-preserved every 5-min cycle, producing ~24M duplicate flight rows from
// ~1.5k real events) and shrinks the DB back to its true size.
//
// Strategy (all inside ONE transaction, so it either fully succeeds or rolls back):
//   1. Collapse preservation_events to one row per `hour` (keep the earliest id).
//   2. Repoint preserved_flight_detail rows at the surviving event id.
//   3. Delete duplicate preserved_flight_detail rows, keeping one per
//      (event_id, poll_time, icao24, callsign).
//   4. Add UNIQUE indexes so the duplication can never recur.
//   5. (optional) Apply a retention window: drop summary data older than
//      RETAIN_DAYS, but NEVER touch preserved events (those are the point).
//   6. VACUUM to return the freed space to the OS.
//
// SAFETY: run cleanup-db.js first to make a backup, OR pass --backup here.
// Usage (inside the container, from /app):
//   node dedup-preservation.js --dry-run        # report only, change nothing
//   node dedup-preservation.js                  # dedup + reindex + vacuum
//   node dedup-preservation.js --retain-days=90 # also age out old summaries
//   node dedup-preservation.js --backup         # VACUUM INTO a backup first

const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const DB_PATH = process.env.DB_PATH || "/app/data/cloudseeding.db";
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const DO_BACKUP = args.includes("--backup");
const retainArg = args.find((a) => a.startsWith("--retain-days="));
const RETAIN_DAYS = retainArg ? parseInt(retainArg.split("=")[1]) : null;

const mb = (b) => (b / 1024 / 1024).toFixed(1) + " MB";
const gb = (b) => (b / 1024 / 1024 / 1024).toFixed(2) + " GB";
const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

console.log(`\nTarget: ${DB_PATH}  (${gb(sizeOf(DB_PATH))})`);
console.log(DRY ? "MODE: dry-run (no changes)\n" : "MODE: live\n");

const db = new Database(DB_PATH, { timeout: 120000 });
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = OFF"); // we are repointing FKs deliberately

const count = (sql, ...p) => db.prepare(sql).get(...p).n;

// ── Current state ──
const eventsTotal = count("SELECT COUNT(*) n FROM preservation_events");
const eventsDistinct = count("SELECT COUNT(DISTINCT hour) n FROM preservation_events");
const pfdTotal = count("SELECT COUNT(*) n FROM preserved_flight_detail");
console.log(`preservation_events : ${eventsTotal.toLocaleString()} rows, ${eventsDistinct.toLocaleString()} distinct hours`);
console.log(`preserved_flight_detail : ${pfdTotal.toLocaleString()} rows`);

if (DRY) {
  // Estimate survivors without changing anything.
  const survivingRows = count(`
    SELECT COUNT(*) n FROM (
      SELECT 1 FROM preserved_flight_detail
      GROUP BY event_id, poll_time, icao24, callsign
    )
  `);
  console.log(`\nWould collapse events to ${eventsDistinct.toLocaleString()} (one per hour).`);
  console.log(`Would keep ~${survivingRows.toLocaleString()} unique flight rows ` +
              `(removing ~${(pfdTotal - survivingRows).toLocaleString()} duplicates).`);
  if (RETAIN_DAYS) console.log(`Would age out summaries older than ${RETAIN_DAYS} days.`);
  db.close();
  process.exit(0);
}

if (DO_BACKUP) {
  const bk = path.join(path.dirname(DB_PATH), "cloudseeding-backup.db");
  console.log(`Backing up (compacted) to ${bk} ...`);
  try { fs.rmSync(bk); } catch {}
  db.exec(`VACUUM INTO '${bk}'`);
  console.log(`  backup: ${gb(sizeOf(bk))}\n`);
}

const before = sizeOf(DB_PATH);

// SPACE-SAFE STRATEGY: the table is ~99% duplicates, so deleting 23.8M rows in
// one transaction would balloon the WAL beyond free disk. Instead we BUILD a
// clean table containing only survivors and swap it in. This writes only the
// small surviving set, keeps the WAL tiny, and the old bloated table is dropped
// wholesale (cheap). Periodic checkpoints keep the WAL truncated throughout.

const tx = db.transaction(() => {
  console.log("[1/6] Building survivor map (one event per hour)...");
  db.exec(`
    CREATE TEMP TABLE _survivor AS
    SELECT hour, MIN(id) AS keep_id FROM preservation_events GROUP BY hour;
    CREATE INDEX _surv_keep ON _survivor(keep_id);
    CREATE TEMP TABLE _remap AS
    SELECT e.id AS old_id, s.keep_id AS new_id
    FROM preservation_events e JOIN _survivor s ON s.hour = e.hour;
    CREATE INDEX _remap_old ON _remap(old_id);
  `);

  console.log("[2/6] Rebuilding preserved_flight_detail with unique survivors...");
  // New table, same columns. Insert one row per logical key, with event_id
  // already repointed to the surviving event. GROUP BY collapses duplicates.
  db.exec(`
    CREATE TABLE preserved_flight_detail_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      poll_time TEXT NOT NULL, icao24 TEXT, callsign TEXT NOT NULL,
      lat REAL NOT NULL, lng REAL NOT NULL, altitude_ft REAL, speed_kts REAL,
      heading REAL, vertical_rate REAL, squawk TEXT,
      is_known_seeder INTEGER DEFAULT 0, operator TEXT, aircraft_type TEXT
    );
  `);
  db.exec(`
    INSERT INTO preserved_flight_detail_new
      (event_id, poll_time, icao24, callsign, lat, lng, altitude_ft, speed_kts,
       heading, vertical_rate, squawk, is_known_seeder, operator, aircraft_type)
    SELECT
      (SELECT new_id FROM _remap WHERE old_id = pfd.event_id) AS event_id,
      poll_time, icao24, callsign, MIN(lat), MIN(lng), MIN(altitude_ft),
      MIN(speed_kts), MIN(heading), MIN(vertical_rate), MIN(squawk),
      MIN(is_known_seeder), MIN(operator), MIN(aircraft_type)
    FROM preserved_flight_detail pfd
    GROUP BY
      (SELECT new_id FROM _remap WHERE old_id = pfd.event_id),
      poll_time, icao24, callsign;
  `);

  console.log("[3/6] Swapping tables (dropping the bloated original)...");
  db.exec(`DROP TABLE preserved_flight_detail;`);
  db.exec(`ALTER TABLE preserved_flight_detail_new RENAME TO preserved_flight_detail;`);

  console.log("[4/6] Collapsing duplicate event records...");
  db.exec(`DELETE FROM preservation_events WHERE id NOT IN (SELECT keep_id FROM _survivor);`);

  console.log("[5/6] Recreating indexes + UNIQUE guards...");
  db.exec(`
    CREATE INDEX idx_pfd_event ON preserved_flight_detail(event_id);
    CREATE INDEX idx_pfd_poll  ON preserved_flight_detail(poll_time);
    CREATE INDEX idx_pfd_cs    ON preserved_flight_detail(callsign);
    CREATE INDEX idx_pfd_pos   ON preserved_flight_detail(lat, lng);
    CREATE UNIQUE INDEX uq_pe_hour ON preservation_events(hour);
    CREATE UNIQUE INDEX uq_pfd_logical
      ON preserved_flight_detail(event_id, poll_time, icao24, callsign);
  `);

  if (RETAIN_DAYS) {
    const cutoff = new Date(Date.now() - RETAIN_DAYS * 86400000)
      .toISOString().slice(0, 13) + ":00:00";
    const w = db.prepare("DELETE FROM weather_grid WHERE timestamp < ?").run(cutoff);
    const f = db.prepare("DELETE FROM flight_hourly_detail WHERE hour < ?").run(cutoff);
    const t = db.prepare("DELETE FROM traffic_hourly_summary WHERE hour < ?").run(cutoff);
    console.log(`[6/6] Retention (${RETAIN_DAYS}d, cutoff ${cutoff}): ` +
                `weather -${w.changes}, flight_hourly -${f.changes}, traffic -${t.changes}`);
  } else {
    console.log("[6/6] No retention window applied (pass --retain-days=N to enable).");
  }

  db.exec(`DROP TABLE _survivor; DROP TABLE _remap;`);
});

tx();

// Reclaim freed space.
console.log("\nVACUUM (reclaiming space)...");
db.pragma("auto_vacuum = INCREMENTAL");
db.exec("VACUUM");
db.pragma("wal_checkpoint(TRUNCATE)");

const eventsAfter = count("SELECT COUNT(*) n FROM preservation_events");
const pfdAfter = count("SELECT COUNT(*) n FROM preserved_flight_detail");
db.close();

console.log(`\n✓ Done.`);
console.log(`  preservation_events:     ${eventsTotal.toLocaleString()} → ${eventsAfter.toLocaleString()}`);
console.log(`  preserved_flight_detail: ${pfdTotal.toLocaleString()} → ${pfdAfter.toLocaleString()}`);
console.log(`  DB size: ${gb(before)} → ${gb(sizeOf(DB_PATH))}`);
