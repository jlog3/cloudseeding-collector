#!/usr/bin/env node
// ─── STORAGE MONITOR & DIAGNOSTICS ────────────────────────────────────────────
// Records DB vitals so a slow leak is caught early, and reclaims free pages.
//   node monitor.js            # log + print report
//   node monitor.js --check    # exit non-zero if a threshold is breached
//   node monitor.js --vacuum   # also reclaim free pages in place

const Database = require("better-sqlite3");
const fs = require("fs");
const cfg = require("./config");

const DB_PATH = cfg.DB_PATH;
const CHECK = process.argv.includes("--check");
const DO_VACUUM = process.argv.includes("--vacuum");

const MAX_RAW_FLIGHT_AGE_HOURS = Number(process.env.MAX_RAW_FLIGHT_AGE_HOURS || (cfg.RAW_RETENTION_HOURS + 12));
const FREELIST_WARN_FRACTION = 0.25;
const FILE_SIZE_WARN_BYTES = 4.0 * 1024 ** 3;

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS storage_log (
    ts TEXT PRIMARY KEY, file_bytes INTEGER, wal_bytes INTEGER,
    page_count INTEGER, freelist_count INTEGER, page_size INTEGER,
    raw_flight_rows INTEGER, raw_flight_oldest TEXT, raw_flight_newest TEXT,
    weather_rows INTEGER, flight_hourly_rows INTEGER, seeder_rows INTEGER,
    preserved_rows INTEGER, traffic_rows INTEGER
  )`);

const fileBytes = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
const tableRows = (n) => { try { return db.prepare(`SELECT COUNT(*) n FROM ${n}`).get().n; } catch { return -1; } };
const hoursBetween = (a, b) => (!a || !b ? 0 : (new Date(b + "Z").getTime() - new Date(a + "Z").getTime()) / 3600000);

const pageCount = db.pragma("page_count", { simple: true });
const freelist = db.pragma("freelist_count", { simple: true });
const pageSize = db.pragma("page_size", { simple: true });

let rawOldest = null, rawNewest = null;
try { const r = db.prepare("SELECT MIN(poll_time) lo, MAX(poll_time) hi FROM flights_seeding_alt").get(); rawOldest = r.lo; rawNewest = r.hi; } catch {}

const snapshot = {
  ts: new Date().toISOString(), file_bytes: fileBytes(DB_PATH), wal_bytes: fileBytes(DB_PATH + "-wal"),
  page_count: pageCount, freelist_count: freelist, page_size: pageSize,
  raw_flight_rows: tableRows("flights_seeding_alt"), raw_flight_oldest: rawOldest, raw_flight_newest: rawNewest,
  weather_rows: tableRows("weather_grid"), flight_hourly_rows: tableRows("flight_hourly_detail"),
  seeder_rows: tableRows("seeder_tracks"), preserved_rows: tableRows("preserved_flight_detail"),
  traffic_rows: tableRows("traffic_hourly_summary"),
};
db.prepare(`INSERT OR REPLACE INTO storage_log
  (ts,file_bytes,wal_bytes,page_count,freelist_count,page_size,raw_flight_rows,
   raw_flight_oldest,raw_flight_newest,weather_rows,flight_hourly_rows,seeder_rows,
   preserved_rows,traffic_rows)
  VALUES (@ts,@file_bytes,@wal_bytes,@page_count,@freelist_count,@page_size,@raw_flight_rows,
   @raw_flight_oldest,@raw_flight_newest,@weather_rows,@flight_hourly_rows,@seeder_rows,
   @preserved_rows,@traffic_rows)`).run(snapshot);

const gb = (b) => (b / 1024 ** 3).toFixed(3) + " GB";
const mb = (b) => (b / 1024 ** 2).toFixed(1) + " MB";
const freeFrac = pageCount ? freelist / pageCount : 0;
const reclaimable = freelist * pageSize;
const rawAge = hoursBetween(rawOldest, rawNewest);

console.log(`\n─── CloudSeedWatch storage report ${snapshot.ts} ───`);
console.log(`DB file:        ${gb(snapshot.file_bytes)}  (+ WAL ${mb(snapshot.wal_bytes)})`);
console.log(`Pages:          ${pageCount} total, ${freelist} free (${(freeFrac * 100).toFixed(1)}% ≈ ${mb(reclaimable)})`);
console.log(`Raw flights:    ${snapshot.raw_flight_rows.toLocaleString()} rows spanning ${rawAge.toFixed(1)}h`);
console.log(`                oldest ${rawOldest || "—"}  newest ${rawNewest || "—"}`);
console.log(`Forever tables: weather ${snapshot.weather_rows.toLocaleString()}, ` +
  `hourly ${snapshot.flight_hourly_rows.toLocaleString()}, seeder ${snapshot.seeder_rows.toLocaleString()}, ` +
  `preserved ${snapshot.preserved_rows.toLocaleString()}, traffic ${snapshot.traffic_rows.toLocaleString()}`);
console.log(`Analysis:       forecast ${tableRows("weather_forecast").toLocaleString()}, ` +
  `anomalies ${tableRows("weather_anomalies").toLocaleString()}, ` +
  `candidates ${tableRows("anomaly_candidates").toLocaleString()}, ` +
  `airframes ${tableRows("airframe_scores").toLocaleString()}, ` +
  `registry ${tableRows("seeder_registry").toLocaleString()}`);

const prev = db.prepare("SELECT * FROM storage_log WHERE ts < ? ORDER BY ts DESC LIMIT 1").get(snapshot.ts);
if (prev) {
  const days = hoursBetween(prev.ts.slice(0, 19), snapshot.ts.slice(0, 19)) / 24;
  const grown = snapshot.file_bytes - prev.file_bytes;
  if (days > 0) console.log(`Growth:         ${mb(grown)} since last check (${mb(grown / days)}/day → ~${gb((grown / days) * 365)}/yr)`);
}

const warnings = [];
if (rawAge > MAX_RAW_FLIGHT_AGE_HOURS) warnings.push(`Raw flight rows span ${rawAge.toFixed(0)}h (> ${MAX_RAW_FLIGHT_AGE_HOURS}h). COMPACTION MAY BE STALLED.`);
if (freeFrac > FREELIST_WARN_FRACTION) warnings.push(`${(freeFrac * 100).toFixed(0)}% empty pages. Run VACUUM to reclaim ~${mb(reclaimable)}.`);
if (snapshot.file_bytes > FILE_SIZE_WARN_BYTES) warnings.push(`DB is ${gb(snapshot.file_bytes)}, approaching the volume cap.`);

if (warnings.length) { console.log(`\n⚠  ${warnings.length} WARNING(S):`); for (const w of warnings) console.log(`   • ${w}`); }
else console.log(`\n✓ Healthy: compaction window normal, low bloat, headroom OK.`);
console.log("");

if (DO_VACUUM) {
  const before = fileBytes(DB_PATH);
  const mode = db.pragma("auto_vacuum", { simple: true });
  if (mode === 0) {
    console.log("auto_vacuum is NONE. One-time full VACUUM needed to enable in-place reclaim:\n" +
      "  sqlite3 cloudseeding.db \"PRAGMA auto_vacuum=INCREMENTAL; VACUUM;\"");
  } else {
    db.pragma("incremental_vacuum");
    db.pragma("wal_checkpoint(TRUNCATE)");
    const after = fileBytes(DB_PATH);
    console.log(`Incremental vacuum: ${gb(before)} → ${gb(after)} (reclaimed ${mb(Math.max(0, before - after))}).\n`);
  }
}

db.close();
if (CHECK && warnings.length) process.exit(1);
