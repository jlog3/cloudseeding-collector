#!/usr/bin/env node
// ─── CONUS COLLECTOR (v2) ───────────────────────────────────────────────────
// One cycle: ingest flights → ingest weather (+forward forecast) → run the
// layered analysis (anomaly detection, candidate scoring, preservation,
// compaction). Run every 5 min via collect-loop.js.
//
// What changed vs v1:
//   • Identity is icao24 (stable), matched against the seeder_registry — not the
//     spoofable callsign.
//   • Flight source is pluggable with auth + fallback (sources/flights.js): the
//     real fix for the 429 / "fetch failed" cycles.
//   • Weather is batched and also persists the FORWARD forecast, enabling a true
//     counterfactual baseline (sources/weather.js).
//   • Detection is anomaly-first + wind-coupled (analysis.js), with a
//     seedability gate — not aircraft-first loiter noise.

const Database = require("better-sqlite3");
const cfg = require("./config");
const { fetchFlights } = require("./sources/flights");
const { fetchWeatherGrid } = require("./sources/weather");
const { loadSeederRegistry, classify } = require("./seeders");
const analysis = require("./analysis");

async function collect() {
  const db = new Database(cfg.DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  const now = new Date();
  const nowISO = now.toISOString();
  const hourISO = nowISO.slice(0, 13) + ":00:00";
  console.log(`[${nowISO}] CONUS collection cycle starting...`);

  const registry = loadSeederRegistry(db);
  console.log(`  Registry: ${registry.size} known-seeder airframe(s), ${registry.patterns.length} operator pattern(s)`);

  // ══ FLIGHTS ════════════════════════════════════════════════════════════════
  const insSeedingAlt = db.prepare(`
    INSERT INTO flights_seeding_alt
      (poll_time, icao24, callsign, lat, lng, altitude_ft, speed_kts, heading,
       vertical_rate, squawk, is_known_seeder, operator, aircraft_type, on_ground)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insSeeder = db.prepare(`
    INSERT INTO seeder_tracks
      (poll_time, icao24, callsign, lat, lng, altitude_ft, speed_kts, heading,
       vertical_rate, squawk, operator, aircraft_type)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

  let totalAircraft = 0, seedingAltCount = 0, highAltCount = 0, lowAltCount = 0, knownSeederCount = 0;
  const seederCallsigns = new Set();

  try {
    const { states, meta } = await fetchFlights();
    if (meta.notes.length) for (const n of meta.notes) console.log(`    · ${n}`);

    const tx = db.transaction(() => {
      for (const s of states) {
        if (s.on_ground || s.lat == null || s.lng == null) continue;
        const cls = classify(s.icao24, s.callsign, registry);
        // Identity for the callsign column: real callsign, else the hex (so the
        // hourly UNIQUE(hour,callsign) never collides empty callsigns).
        const csKey = s.callsign || s.icao24 || "UNKNOWN";
        const alt = s.alt_ft ?? 0;
        totalAircraft++;

        if (alt < cfg.STORE_ALT_MIN) lowAltCount++;
        else if (alt > cfg.STORE_ALT_MAX) highAltCount++;
        else seedingAltCount++;

        const inStore = alt >= cfg.STORE_ALT_MIN && alt <= cfg.STORE_ALT_MAX;
        if (inStore || cls.isKnownSeeder) {
          insSeedingAlt.run(
            nowISO, s.icao24, csKey, s.lat, s.lng, s.alt_ft, s.speed_kts,
            s.heading, s.vrate_fpm, s.squawk, cls.isKnownSeeder ? 1 : 0,
            cls.operator || "", cls.type || "", s.on_ground
          );
        }
        if (cls.isKnownSeeder) {
          knownSeederCount++;
          seederCallsigns.add(csKey);
          insSeeder.run(
            nowISO, s.icao24, csKey, s.lat, s.lng, s.alt_ft, s.speed_kts,
            s.heading, s.vrate_fpm, s.squawk, cls.operator || "", cls.type || ""
          );
        }
      }
    });
    tx();

    console.log(`  ✓ Flights via ${meta.source}: ${totalAircraft} total`);
    console.log(`    ├─ stored band (${cfg.STORE_ALT_MIN}-${cfg.STORE_ALT_MAX} ft): ${seedingAltCount}`);
    console.log(`    ├─ high alt (>${cfg.STORE_ALT_MAX} ft): ${highAltCount} counted`);
    console.log(`    ├─ low alt (<${cfg.STORE_ALT_MIN} ft): ${lowAltCount} counted`);
    console.log(`    └─ known seeders: ${knownSeederCount} (${[...seederCallsigns].join(", ") || "none"})`);

    db.prepare(`
      INSERT OR REPLACE INTO traffic_hourly_summary
        (hour, total_aircraft, seeding_alt_aircraft, high_alt_aircraft,
         low_alt_aircraft, known_seeder_count, known_seeder_callsigns)
      VALUES (?,?,?,?,?,?,?)`).run(
      hourISO, totalAircraft, seedingAltCount, highAltCount, lowAltCount,
      knownSeederCount, [...seederCallsigns].join(",")
    );
  } catch (err) {
    console.error(`  ✗ Flights: ${err.message}`);
  }

  // ══ WEATHER (grid + forward forecast), once per hour ═════════════════════════
  const haveHour = db.prepare("SELECT COUNT(*) n FROM weather_grid WHERE timestamp = ?").get(hourISO);
  if (haveHour.n === 0) {
    console.log(`  Weather grid sweep for ${hourISO}...`);
    try {
      const { current, forecasts, gridOk, gridErr, totalPoints } = await fetchWeatherGrid(nowISO);

      const insWeather = db.prepare(`
        INSERT OR REPLACE INTO weather_grid
          (grid_lat, grid_lng, timestamp, temperature, humidity, wind_speed, wind_dir,
           precip_rate, precip_prob, cloud_cover, cloud_cover_low, cloud_cover_mid,
           cloud_cover_high, pressure, dewpoint, visibility, freezing_level_m)
        VALUES (@grid_lat,@grid_lng,@timestamp,@temperature,@humidity,@wind_speed,@wind_dir,
           @precip_rate,@precip_prob,@cloud_cover,@cloud_cover_low,@cloud_cover_mid,
           @cloud_cover_high,@pressure,@dewpoint,@visibility,@freezing_level_m)`);
      const insForecast = db.prepare(`
        INSERT OR IGNORE INTO weather_forecast
          (grid_lat, grid_lng, target_hour, issued_at, cloud_cover, precip_rate, precip_prob)
        VALUES (@grid_lat,@grid_lng,@target_hour,@issued_at,@cloud_cover,@precip_rate,@precip_prob)`);

      db.transaction(() => {
        for (const r of current) insWeather.run(r);
        for (const f of forecasts) insForecast.run(f);
      })();

      console.log(`  ✓ Weather: ${gridOk}/${totalPoints} grid points (${gridErr} errors), ${forecasts.length} forecast rows`);
    } catch (err) {
      console.error(`  ✗ Weather: ${err.message}`);
    }
  } else {
    console.log(`  ○ Weather: ${hourISO} already collected (${haveHour.n} points)`);
  }

  // Prune forecast rows for hours that have already passed + been analyzed, to
  // keep weather_forecast from growing without bound (we only need each target
  // hour's forecasts until that hour is compacted/analyzed).
  const fcCutoff = new Date(now.getTime() - (cfg.RAW_RETENTION_HOURS + 6) * 3600000)
    .toISOString().slice(0, 19);
  db.prepare("DELETE FROM weather_forecast WHERE target_hour < ?").run(fcCutoff);

  // ══ LAYERED ANALYSIS (detect → score → preserve → compact) ═══════════════════
  try {
    const res = await analysis.runMaintenance(db, registry, now);
    if (res.hoursCompacted > 0) {
      console.log(`  Analysis: ${res.hoursCompacted} hour(s) compacted, ` +
        `${res.anomalyCount} anomalies, ${res.candidateCount} candidates, ${res.preservedEvents} preserved`);
      for (const line of res.log) console.log(`    ${line}`);
    }
  } catch (err) {
    console.error(`  ✗ Analysis: ${err.message}`);
  }

  // ══ Stats ════════════════════════════════════════════════════════════════════
  const c = (q) => { try { return db.prepare(q).get().n; } catch { return -1; } };
  const pageCount = db.pragma("page_count", { simple: true });
  const pageSize = db.pragma("page_size", { simple: true });
  const dbMB = ((pageCount * pageSize) / 1048576).toFixed(1);
  console.log(`  DB: ${dbMB} MB | weather: ${c("SELECT COUNT(*) n FROM weather_grid")} | ` +
    `flights(raw): ${c("SELECT COUNT(*) n FROM flights_seeding_alt")} | ` +
    `hourly: ${c("SELECT COUNT(*) n FROM flight_hourly_detail")} | ` +
    `seeders: ${c("SELECT COUNT(*) n FROM seeder_tracks")} | ` +
    `anomalies: ${c("SELECT COUNT(*) n FROM weather_anomalies")} | ` +
    `candidates: ${c("SELECT COUNT(*) n FROM anomaly_candidates")} | ` +
    `events: ${c("SELECT COUNT(*) n FROM preservation_events")}`);

  db.close();
  console.log(`[${new Date().toISOString()}] Done.\n`);
}

collect().catch((err) => { console.error("Collector error:", err); process.exit(1); });
