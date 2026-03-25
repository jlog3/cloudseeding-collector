#!/usr/bin/env node
// ─── CONUS-WIDE DATA COLLECTOR ──────────────────────────────────────────────
// Polls the ENTIRE mainland US for flights + weather grid.
//
// Flight strategy:
//   - One OpenSky pull covers all of CONUS (lat 24-50, lng -125 to -66)
//   - Aircraft at seeding altitude (5k-30k ft) stored in FULL detail
//   - Known seeders at ANY altitude stored permanently
//   - Commercial traffic (>30k ft) counted but not individually stored
//
// Weather strategy:
//   - 2° grid across CONUS = ~195 points
//   - Queried in batches from Open-Meteo (which supports multi-point)
//   - Only current hour stored per poll (full 24h backfill on first run)
//
// Run via cron every 5 minutes:  */5 * * * * node collect.js
// Or as a loop:                  node collect-loop.js

const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "cloudseeding.db");

// ─── CONUS bounds ───────────────────────────────────────────────────────────
const CONUS = { latMin: 24, latMax: 50, lngMin: -125, lngMax: -66 };
const SEEDING_ALT_MIN = 5000;   // ft
const SEEDING_ALT_MAX = 30000;  // ft
const WEATHER_GRID_STEP = 2;    // degrees

// ─── Known seeder aircraft ──────────────────────────────────────────────────
const KNOWN_SEEDERS = {
  N350WM:  { type: "King Air 350", operator: "Weather Modification Inc." },
  N68WM:   { type: "King Air C90", operator: "Weather Modification Inc." },
  N802WM:  { type: "Beech King Air 200", operator: "Weather Modification Inc." },
  N44PG:   { type: "Piper PA-31", operator: "North American Weather Consultants" },
  N72GC:   { type: "Cessna 340", operator: "Western Weather Consultants" },
  N90KA:   { type: "King Air 90", operator: "Ice Crystal Engineering" },
};

// ─── API calls ──────────────────────────────────────────────────────────────

async function fetchFlightsCONUS() {
  const url =
    `https://opensky-network.org/api/states/all` +
    `?lamin=${CONUS.latMin}&lamax=${CONUS.latMax}` +
    `&lomin=${CONUS.lngMin}&lomax=${CONUS.lngMax}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OpenSky ${res.status}`);
  const json = await res.json();
  return json.states || [];
}

async function fetchWeatherPoint(lat, lng) {
  const vars = [
    "temperature_2m", "relative_humidity_2m", "precipitation",
    "precipitation_probability", "cloud_cover", "cloud_cover_low",
    "cloud_cover_mid", "cloud_cover_high", "wind_speed_10m",
    "wind_direction_10m", "pressure_msl", "dewpoint_2m", "visibility",
  ].join(",");
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&hourly=${vars}&past_hours=1&forecast_hours=1` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=UTC`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.reason);
  return json.hourly;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main collector ─────────────────────────────────────────────────────────

async function collect() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  const now = new Date();
  const nowISO = now.toISOString();
  const hourISO = nowISO.slice(0, 13) + ":00:00";
  console.log(`[${nowISO}] CONUS collection cycle starting...`);

  // ══════════════════════════════════════════════════════════════════════════
  // FLIGHTS — single CONUS-wide pull
  // ══════════════════════════════════════════════════════════════════════════

  const insertSeedingAlt = db.prepare(`
    INSERT INTO flights_seeding_alt
      (poll_time, icao24, callsign, lat, lng, altitude_ft, speed_kts,
       heading, vertical_rate, squawk, is_known_seeder, operator, aircraft_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSeeder = db.prepare(`
    INSERT INTO seeder_tracks
      (poll_time, icao24, callsign, lat, lng, altitude_ft, speed_kts,
       heading, vertical_rate, squawk, operator, aircraft_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalAircraft = 0, seedingAltCount = 0, highAltCount = 0, lowAltCount = 0;
  let knownSeederCount = 0;
  const seederCallsigns = new Set();

  try {
    const states = await fetchFlightsCONUS();
    const pollTime = nowISO;

    const flightTx = db.transaction(() => {
      for (const sv of states) {
        const latitude = sv[6];
        const longitude = sv[5];
        const onGround = sv[8];
        if (onGround || latitude == null || longitude == null) continue;

        const callsign = (sv[1] || "").trim().toUpperCase();
        if (!callsign) continue;

        const altMeters = sv[13] ?? sv[7] ?? 0;
        const altFt = Math.round(altMeters * 3.28084);
        const speedKts = Math.round((sv[9] ?? 0) * 1.94384);
        const heading = Math.round(sv[10] ?? 0);
        const vertRate = Math.round((sv[11] ?? 0) * 196.85); // m/s → ft/min
        const squawk = sv[14] || "";
        const icao24 = sv[0] || "";

        const isSeeder = callsign in KNOWN_SEEDERS;
        const seederInfo = isSeeder ? KNOWN_SEEDERS[callsign] : null;

        totalAircraft++;

        // Categorize by altitude
        if (altFt < SEEDING_ALT_MIN) {
          lowAltCount++;
        } else if (altFt > SEEDING_ALT_MAX) {
          highAltCount++;
        } else {
          seedingAltCount++;
        }

        // Store seeding-altitude aircraft in full detail (the correlation pool)
        if (altFt >= SEEDING_ALT_MIN && altFt <= SEEDING_ALT_MAX) {
          insertSeedingAlt.run(
            pollTime, icao24, callsign, latitude, longitude, altFt,
            speedKts, heading, vertRate, squawk,
            isSeeder ? 1 : 0,
            seederInfo?.operator || "",
            seederInfo?.type || "",
          );
        }

        // Store known seeders at ANY altitude permanently
        if (isSeeder) {
          knownSeederCount++;
          seederCallsigns.add(callsign);
          insertSeeder.run(
            pollTime, icao24, callsign, latitude, longitude, altFt,
            speedKts, heading, vertRate, squawk,
            seederInfo?.operator || "",
            seederInfo?.type || "",
          );
        }
      }
    });
    flightTx();

    console.log(`  ✓ Flights: ${totalAircraft} total CONUS`);
    console.log(`    ├─ Seeding alt (${SEEDING_ALT_MIN/1000}k-${SEEDING_ALT_MAX/1000}k ft): ${seedingAltCount} stored`);
    console.log(`    ├─ High alt (>${SEEDING_ALT_MAX/1000}k ft): ${highAltCount} counted`);
    console.log(`    ├─ Low alt (<${SEEDING_ALT_MIN/1000}k ft): ${lowAltCount} counted`);
    console.log(`    └─ Known seeders: ${knownSeederCount} (${[...seederCallsigns].join(", ") || "none"})`);

    // Store traffic summary for this hour
    db.prepare(`
      INSERT OR REPLACE INTO traffic_hourly_summary
        (hour, total_aircraft, seeding_alt_aircraft, high_alt_aircraft,
         low_alt_aircraft, known_seeder_count, known_seeder_callsigns)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      hourISO, totalAircraft, seedingAltCount, highAltCount,
      lowAltCount, knownSeederCount, [...seederCallsigns].join(",")
    );

  } catch (err) {
    console.error(`  ✗ Flights: ${err.message}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WEATHER — grid across CONUS
  // Only run the full grid sweep once per hour (check if this hour exists)
  // ══════════════════════════════════════════════════════════════════════════

  const existingWeather = db.prepare(
    "SELECT COUNT(*) as n FROM weather_grid WHERE timestamp = ?"
  ).get(hourISO);

  if (existingWeather.n === 0) {
    console.log(`  Weather grid sweep for ${hourISO}...`);
    const insertWeather = db.prepare(`
      INSERT OR REPLACE INTO weather_grid
        (grid_lat, grid_lng, timestamp, temperature, humidity, wind_speed,
         wind_dir, precip_rate, precip_prob, cloud_cover, cloud_cover_low,
         cloud_cover_mid, cloud_cover_high, pressure, dewpoint, visibility)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let weatherPoints = 0;
    let weatherErrors = 0;

    for (let lat = CONUS.latMin; lat <= CONUS.latMax; lat += WEATHER_GRID_STEP) {
      for (let lng = CONUS.lngMin; lng <= CONUS.lngMax; lng += WEATHER_GRID_STEP) {
        try {
          const h = await fetchWeatherPoint(lat, lng);
          // Find the index closest to the current hour
          const times = h.time || [];
          let idx = 0;
          let minDiff = Infinity;
          for (let i = 0; i < times.length; i++) {
            const diff = Math.abs(new Date(times[i]).getTime() - now.getTime());
            if (diff < minDiff) { minDiff = diff; idx = i; }
          }

          insertWeather.run(
            lat, lng, hourISO,
            h.temperature_2m?.[idx], h.relative_humidity_2m?.[idx],
            h.wind_speed_10m?.[idx], h.wind_direction_10m?.[idx],
            h.precipitation?.[idx], h.precipitation_probability?.[idx],
            h.cloud_cover?.[idx], h.cloud_cover_low?.[idx],
            h.cloud_cover_mid?.[idx], h.cloud_cover_high?.[idx],
            h.pressure_msl?.[idx], h.dewpoint_2m?.[idx],
            h.visibility?.[idx],
          );
          weatherPoints++;
        } catch (err) {
          weatherErrors++;
        }
        // Respect rate limits — small delay between calls
        await sleep(100);
      }
    }
    console.log(`  ✓ Weather: ${weatherPoints} grid points (${weatherErrors} errors)`);
  } else {
    console.log(`  ○ Weather: ${hourISO} already collected (${existingWeather.n} points)`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // COMPACTION — turn 48h-old flight detail into per-callsign hourly rows
  // ══════════════════════════════════════════════════════════════════════════

  const compactCutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

  const oldRows = db.prepare(`
    SELECT strftime('%Y-%m-%dT%H:00:00', poll_time) as hour,
           callsign, icao24, is_known_seeder, operator, aircraft_type,
           MIN(lat) as min_lat, MAX(lat) as max_lat,
           MIN(lng) as min_lng, MAX(lng) as max_lng,
           AVG(lat) as avg_lat, AVG(lng) as avg_lng,
           MIN(altitude_ft) as min_alt, MAX(altitude_ft) as max_alt,
           AVG(altitude_ft) as avg_alt,
           AVG(speed_kts) as avg_speed,
           AVG(heading) as avg_heading,
           COUNT(*) as sightings
    FROM flights_seeding_alt
    WHERE poll_time < ?
    GROUP BY hour, callsign
  `).all(compactCutoff);

  if (oldRows.length > 0) {
    const insertHourly = db.prepare(`
      INSERT OR REPLACE INTO flight_hourly_detail
        (hour, callsign, icao24, is_known_seeder, operator, aircraft_type,
         min_lat, max_lat, min_lng, max_lng, avg_lat, avg_lng,
         min_alt_ft, max_alt_ft, avg_alt_ft, avg_speed_kts, avg_heading, sightings)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const compactTx = db.transaction(() => {
      for (const r of oldRows) {
        insertHourly.run(
          r.hour, r.callsign, r.icao24, r.is_known_seeder,
          r.operator, r.aircraft_type,
          r.min_lat, r.max_lat, r.min_lng, r.max_lng,
          r.avg_lat, r.avg_lng,
          r.min_alt, r.max_alt, r.avg_alt,
          r.avg_speed, r.avg_heading, r.sightings,
        );
      }
      db.prepare("DELETE FROM flights_seeding_alt WHERE poll_time < ?").run(compactCutoff);
    });
    compactTx();
    console.log(`  Compacted: ${oldRows.length} callsign-hours from older flight data`);
  }

  // ── Stats ──
  const stats = {
    weather: db.prepare("SELECT COUNT(*) as n FROM weather_grid").get().n,
    flightDetail: db.prepare("SELECT COUNT(*) as n FROM flights_seeding_alt").get().n,
    flightHourly: db.prepare("SELECT COUNT(*) as n FROM flight_hourly_detail").get().n,
    seederTracks: db.prepare("SELECT COUNT(*) as n FROM seeder_tracks").get().n,
    trafficSummary: db.prepare("SELECT COUNT(*) as n FROM traffic_hourly_summary").get().n,
  };
  const pageCount = db.pragma("page_count", { simple: true });
  const pageSize = db.pragma("page_size", { simple: true });
  const dbMB = ((pageCount * pageSize) / 1048576).toFixed(1);

  console.log(`  DB size: ${dbMB} MB | weather: ${stats.weather} | flights(48h): ${stats.flightDetail} | compacted: ${stats.flightHourly} | seeders: ${stats.seederTracks} | traffic: ${stats.trafficSummary}`);

  db.close();
  console.log(`[${new Date().toISOString()}] Done.\n`);
}

collect().catch((err) => {
  console.error("Collector error:", err);
  process.exit(1);
});
