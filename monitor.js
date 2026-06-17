#!/usr/bin/env node
// ─── STORAGE MONITOR & DIAGNOSTICS ────────────────────────────────────────────
// Records the database's vital signs so a slow leak is caught BEFORE it fills
// the volume — instead of a month later when collection silently wedges.
//
// What it captures each run:
//   - page_count / freelist_count  → how much of the file is reclaimable bloat
//   - file size on disk (.db + -wal + -shm)
//   - per-table row counts
//   - oldest/newest raw flight rows → proves the 48h compaction is running
//
// It writes one row per run into a `storage_log` table inside the same DB, and
// prints a human-readable report. Run it weekly via cron (see crontab below).
//
//   node monitor.js            # log + print report
//   node monitor.js --check    # also exit non-zero if a threshold is breached
//                              # (so cron/healthchecks can alert)

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "cloudseeding.db");
const CHECK = process.argv.includes("--check");
const DO_VACUUM = process.argv.includes("--vacuum");

// ── Thresholds (tune to your volume size) ──
// Raw flight rows should only ever hold ~48h. At ~12 polls/hr and a few hundred
// seeding-altitude aircraft CONUS-wide, 48h is well under ~1M rows. If it blows
// past this, compaction has stopped — the classic leak.
const MAX_RAW_FLIGHT_AGE_HOURS = 60;           // 48h window + generous margin
const FREELIST_WARN_FRACTION = 0.25;           // >25% of file is empty → VACUUM
const FILE_SIZE_WARN_BYTES = 4.0 * 1024 ** 3;  // warn at 4GB on a 5GB volume

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// Ensure the log table exists.
db.exec(`
  CREATE TABLE IF NOT EXISTS storage_log (
    ts                  TEXT PRIMARY KEY,
    file_bytes          INTEGER,
    wal_bytes           INTEGER,
    page_count          INTEGER,
    freelist_count      INTEGER,
    page_size           INTEGER,
    raw_flight_rows     INTEGER,
    raw_flight_oldest   TEXT,
    raw_flight_newest   TEXT,
    weather_rows        INTEGER,
    flight_hourly_rows  INTEGER,
    seeder_rows         INTEGER,
    preserved_rows      INTEGER,
    traffic_rows        INTEGER
  )
`);

function fileBytes(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}
function tableRows(name) {
  try { return db.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n; }
  catch { return -1; } // table may not exist yet
}
function hoursBetween(a, b) {
  if (!a || !b) return 0;
  return (new Date(b + "Z").getTime() - new Date(a + "Z").getTime()) / 3600000;
}

const pageCount = db.pragma("page_count", { simple: true });
const freelist = db.pragma("freelist_count", { simple: true });
const pageSize = db.pragma("page_size", { simple: true });

const rawRows = tableRows("flights_seeding_alt");
let rawOldest = null, rawNewest = null;
try {
  const r = db.prepare(
    "SELECT MIN(poll_time) lo, MAX(poll_time) hi FROM flights_seeding_alt"
  ).get();
  rawOldest = r.lo; rawNewest = r.hi;
} catch {}

const snapshot = {
  ts: new Date().toISOString(),
  file_bytes: fileBytes(DB_PATH),
  wal_bytes: fileBytes(DB_PATH + "-wal"),
  page_count: pageCount,
  freelist_count: freelist,
  page_size: pageSize,
  raw_flight_rows: rawRows,
  raw_flight_oldest: rawOldest,
  raw_flight_newest: rawNewest,
  weather_rows: tableRows("weather_grid"),
  flight_hourly_rows: tableRows("flight_hourly_detail"),
  seeder_rows: tableRows("seeder_tracks"),
  preserved_rows: tableRows("preserved_flight_detail"),
  traffic_rows: tableRows("traffic_hourly_summary"),
};

db.prepare(`
  INSERT OR REPLACE INTO storage_log
    (ts, file_bytes, wal_bytes, page_count, freelist_count, page_size,
     raw_flight_rows, raw_flight_oldest, raw_flight_newest, weather_rows,
     flight_hourly_rows, seeder_rows, preserved_rows, traffic_rows)
  VALUES
    (@ts, @file_bytes, @wal_bytes, @page_count, @freelist_count, @page_size,
     @raw_flight_rows, @raw_flight_oldest, @raw_flight_newest, @weather_rows,
     @flight_hourly_rows, @seeder_rows, @preserved_rows, @traffic_rows)
`).run(snapshot);

// ── Report ──
const gb = (b) => (b / 1024 ** 3).toFixed(3) + " GB";
const mb = (b) => (b / 1024 ** 2).toFixed(1) + " MB";
const freeFrac = pageCount ? freelist / pageCount : 0;
const reclaimable = freelist * pageSize;
const rawAge = hoursBetween(rawOldest, rawNewest);

console.log(`\n─── CloudSeedWatch storage report ${snapshot.ts} ───`);
console.log(`DB file:        ${gb(snapshot.file_bytes)}  (+ WAL ${mb(snapshot.wal_bytes)})`);
console.log(`Pages:          ${pageCount} total, ${freelist} free (${(freeFrac * 100).toFixed(1)}% reclaimable ≈ ${mb(reclaimable)})`);
console.log(`Raw flights:    ${rawRows.toLocaleString()} rows spanning ${rawAge.toFixed(1)}h`);
console.log(`                oldest ${rawOldest || "—"}  newest ${rawNewest || "—"}`);
console.log(`Forever tables: weather ${snapshot.weather_rows.toLocaleString()}, ` +
            `flight_hourly ${snapshot.flight_hourly_rows.toLocaleString()}, ` +
            `seeder ${snapshot.seeder_rows.toLocaleString()}, ` +
            `preserved ${snapshot.preserved_rows.toLocaleString()}, ` +
            `traffic ${snapshot.traffic_rows.toLocaleString()}`);

// Growth since previous log entry, if any.
const prev = db.prepare(
  "SELECT * FROM storage_log WHERE ts < ? ORDER BY ts DESC LIMIT 1"
).get(snapshot.ts);
if (prev) {
  const days = hoursBetween(prev.ts.slice(0, 19), snapshot.ts.slice(0, 19)) / 24;
  const grown = snapshot.file_bytes - prev.file_bytes;
  if (days > 0) {
    console.log(`Growth:         ${mb(grown)} since last check ` +
                `(${mb(grown / days)}/day → ~${gb(grown / days * 365)}/yr)`);
  }
}

// ── Warnings / threshold checks ──
const warnings = [];
if (rawAge > MAX_RAW_FLIGHT_AGE_HOURS) {
  warnings.push(
    `Raw flight rows span ${rawAge.toFixed(0)}h (> ${MAX_RAW_FLIGHT_AGE_HOURS}h). ` +
    `COMPACTION IS NOT RUNNING — this is the leak. Check collect.js compaction step.`
  );
}
if (freeFrac > FREELIST_WARN_FRACTION) {
  warnings.push(
    `${(freeFrac * 100).toFixed(0)}% of the file is empty pages. ` +
    `Run VACUUM to reclaim ~${mb(reclaimable)}.`
  );
}
if (snapshot.file_bytes > FILE_SIZE_WARN_BYTES) {
  warnings.push(
    `DB is ${gb(snapshot.file_bytes)}, approaching the volume cap. ` +
    `Investigate before it hits 100% (a full volume forces an offline resize + restart).`
  );
}

if (warnings.length) {
  console.log(`\n⚠  ${warnings.length} WARNING(S):`);
  for (const w of warnings) console.log(`   • ${w}`);
} else {
  console.log(`\n✓ Healthy: compaction window normal, low bloat, headroom OK.`);
}
console.log("");

// ── Space reclamation (--vacuum) ──
// SQLite's DELETE frees pages onto an internal free list but never returns
// space to the OS, so the file only grows toward its high-water mark. Under a
// tight volume cap we AVOID a full `VACUUM` (it rewrites the entire DB into a
// temp file, needing up to ~2x the DB size in scratch space — likely to fail
// at 5GB on a 5GB volume, or trigger Railway's offline resize). Instead we use
// auto_vacuum=INCREMENTAL + incremental_vacuum, which reclaims free pages in
// place with negligible extra space.
if (DO_VACUUM) {
  const before = fileBytes(DB_PATH);
  const mode = db.pragma("auto_vacuum", { simple: true }); // 0=NONE 1=FULL 2=INCREMENTAL
  if (mode === 0) {
    // auto_vacuum can only change via a one-time full VACUUM. Only attempt it
    // if there's clearly enough free disk headroom; otherwise warn and skip.
    console.log(
      "auto_vacuum is NONE. To enable in-place reclaim, a one-time full VACUUM " +
      "is required (needs free disk ≈ current DB size). Run manually off-peak:\n" +
      "  sqlite3 cloudseeding.db \"PRAGMA auto_vacuum=INCREMENTAL; VACUUM;\"\n" +
      "After that, this script reclaims incrementally with no extra space."
    );
  } else {
    // INCREMENTAL (or FULL) auto_vacuum: reclaim the free pages now.
    db.pragma("incremental_vacuum");
    db.pragma("wal_checkpoint(TRUNCATE)"); // also flush + shrink the WAL file
    const after = fileBytes(DB_PATH);
    console.log(`Incremental vacuum: ${gb(before)} → ${gb(after)} (reclaimed ${mb(Math.max(0, before - after))}).\n`);
  }
}

db.close();
if (CHECK && warnings.length) process.exit(1);
