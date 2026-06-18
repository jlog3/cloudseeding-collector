// ─── ANALYSIS ENGINE ────────────────────────────────────────────────────────
// The layered detector that replaces the old aircraft-first scoring:
//
//   Layer 1  detectAnomaliesForHour()  – find where conditions exceeded the
//            EARLIER forecast (a real counterfactual), cluster the excess cells,
//            measure linear structure, and gate on cloud SEEDABILITY.
//   Layer 2  scoreCandidatesForAnomaly() – for each anomaly, project UPWIND
//            (wind × lag) and score aircraft that were there before it, by track
//            geometry, altitude band, and wind-coupling consistency.
//   Layer 3  every candidate is written to anomaly_candidates so the aggregate
//            "repeat offender" test (aggregate.js) has data even when no single
//            event is strong enough to preserve.
//   + preservation of strong events + compaction of the rolling raw window.
//
// Honest caveats baked into the design:
//   • Single-event "proof" is not the goal; the power is in repetition.
//   • The forecast baseline needs a few hours of history to warm up; until then
//     we fall back to hour-over-hour persistence.
//   • Real GOES cloud-top temperature would make the seedability gate far better;
//     with model data we use a documented proxy.

const cfg = require("./config");
const geo = require("./geo");
const { getObservedCells } = require("./sources/observations");
const { classify } = require("./seeders");

const A = cfg.ANALYSIS;
const HOUR_MS = 3600000;

// ── ISO helpers (poll_time is full ISO w/ Z; hour keys are "...THH:00:00") ────
const hourKeyOf = (d) => new Date(d).toISOString().slice(0, 13) + ":00:00";
const isoZ = (ms) => new Date(ms).toISOString();

// ── Seedability proxy ─────────────────────────────────────────────────────────
// Glaciogenic seeding only does anything in clouds holding SUPERCOOLED LIQUID
// water (liquid droplets below 0 °C, roughly −5 to −20 °C). The real signal is
// GOES cloud-top temperature; with model fields we proxy: enough mid/low cloud,
// a cold-enough column (low freezing level OR cool surface), and high humidity.
// Returns 0..1.
function seedabilityScore(cell) {
  if (!cell) return 0;
  const cloud = Math.max(
    cell.cloud_cover_mid || 0,
    cell.cloud_cover_low || 0,
    (cell.cloud_cover || 0) * 0.7
  );
  if (cloud < A.seedabilityMinCloud) return 0;

  let cold;
  if (cell.cloud_top_temp_c != null) {
    const t = cell.cloud_top_temp_c; // ideal supercooled band ≈ −5..−20 °C
    cold = t <= -3 && t >= -28 ? 1 : t < -28 ? 0.5 : Math.max(0, -t / 5);
  } else if (cell.freezing_level_m != null) {
    cold =
      cell.freezing_level_m <= 3500
        ? 1
        : Math.max(0, 1 - (cell.freezing_level_m - 3500) / 3000);
  } else {
    cold = (cell.temperature ?? 99) <= A.seedabilityMaxSurfaceTempF ? 1 : 0;
  }

  const humid =
    (cell.humidity ?? 0) >= A.seedabilityMinHumidity
      ? 1
      : Math.max(0, (cell.humidity ?? 0) / A.seedabilityMinHumidity);
  const cloudFactor = Math.min(1, cloud / 80);
  return Math.max(0, Math.min(1, 0.5 * cold + 0.3 * cloudFactor + 0.2 * humid));
}

// ── Grid clustering + elongation ──────────────────────────────────────────────
function clusterCells(cells, step) {
  const adj = step * 1.6;
  const used = new Array(cells.length).fill(false);
  const clusters = [];
  for (let i = 0; i < cells.length; i++) {
    if (used[i]) continue;
    const stack = [i];
    used[i] = true;
    const members = [];
    while (stack.length) {
      const k = stack.pop();
      members.push(cells[k]);
      for (let j = 0; j < cells.length; j++) {
        if (used[j]) continue;
        if (
          Math.abs(cells[k].lat - cells[j].lat) <= adj &&
          Math.abs(cells[k].lng - cells[j].lng) <= adj
        ) {
          used[j] = true;
          stack.push(j);
        }
      }
    }
    clusters.push(members);
  }
  return clusters;
}

// 1 = a line/edge, 0 = a blob (covariance eigenvalue ratio of cell coordinates).
function elongation(members) {
  const n = members.length;
  if (n < 2) return 0;
  let mx = 0, my = 0;
  for (const m of members) { mx += m.lat; my += m.lng; }
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const m of members) {
    const dx = m.lat - mx, dy = m.lng - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  sxx /= n; syy /= n; sxy /= n;
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.max(0, (tr * tr) / 4 - det);
  const l1 = tr / 2 + Math.sqrt(disc);
  const l2 = tr / 2 - Math.sqrt(disc);
  if (l1 <= 1e-9) return 0;
  return Math.max(0, 1 - l2 / l1);
}

// ── Layer 1: anomalies for one hour ───────────────────────────────────────────
async function detectAnomaliesForHour(db, hour) {
  const { cells, meta } = await getObservedCells(db, hour);
  if (!cells.length) return { anomalies: [], obsMeta: meta };

  const prevHour = hourKeyOf(new Date(hour + "Z").getTime() - HOUR_MS);

  const fcStmt = db.prepare(
    `SELECT cloud_cover, precip_rate FROM weather_forecast
     WHERE grid_lat = ? AND grid_lng = ? AND target_hour = ?
     ORDER BY issued_at ASC LIMIT 1`
  );
  const prevObsStmt = db.prepare(
    `SELECT cloud_cover, precip_rate FROM weather_grid
     WHERE grid_lat = ? AND grid_lng = ? AND timestamp = ?`
  );
  const windStmt = db.prepare(
    `SELECT wind_speed, wind_dir FROM weather_grid
     WHERE grid_lat = ? AND grid_lng = ? AND timestamp = ?`
  );

  const hits = [];
  for (const c of cells) {
    const fc = fcStmt.get(c.lat, c.lng, hour);
    let cloudExcess = 0, precipExcess = 0, precipOnset = 0, baselineKind = "none";

    if (fc) {
      baselineKind = "forecast";
      cloudExcess = (c.cloud_cover || 0) - (fc.cloud_cover || 0);
      precipExcess = (c.precip_rate || 0) - (fc.precip_rate || 0);
      if ((fc.precip_rate || 0) <= 0.01 && (c.precip_rate || 0) > 0.05) precipOnset = 1;
    } else {
      baselineKind = "persistence";
      const prev = prevObsStmt.get(c.lat, c.lng, prevHour);
      if (prev) {
        cloudExcess = (c.cloud_cover || 0) - (prev.cloud_cover || 0);
        precipExcess = (c.precip_rate || 0) - (prev.precip_rate || 0);
        if ((prev.precip_rate || 0) <= 0.01 && (c.precip_rate || 0) > 0.05) precipOnset = 1;
      }
    }

    const cloudHit =
      baselineKind === "forecast"
        ? cloudExcess >= A.cloudExcessVsForecast
        : cloudExcess >= A.cloudJumpFallback;
    const precipHit = precipExcess >= A.precipExcessVsForecast || precipOnset === 1;
    if (!cloudHit && !precipHit) continue;

    hits.push({
      ...c,
      _cloudExcess: cloudExcess,
      _precipExcess: precipExcess,
      _precipOnset: precipOnset,
      _baselineKind: baselineKind,
      _seedable: seedabilityScore(c),
    });
  }

  if (!hits.length) return { anomalies: [], obsMeta: meta };

  const clusters = clusterCells(hits, cfg.WEATHER_GRID_STEP);
  const anomalies = [];
  for (const members of clusters) {
    const n = members.length;
    const cLat = members.reduce((s, m) => s + m.lat, 0) / n;
    const cLng = members.reduce((s, m) => s + m.lng, 0) / n;
    const cloudMax = Math.max(...members.map((m) => m._cloudExcess), 0);
    const precipMax = Math.max(...members.map((m) => m._precipExcess), 0);
    const onset = members.some((m) => m._precipOnset) ? 1 : 0;
    const seedableFrac =
      members.reduce((s, m) => s + (m._seedable >= 0.5 ? 1 : 0), 0) / n;
    const seedableMean = members.reduce((s, m) => s + m._seedable, 0) / n;
    const elong = elongation(members);
    const baselineKind = members.some((m) => m._baselineKind === "forecast")
      ? "forecast"
      : "persistence";

    // Wind at the cluster centroid (snap to grid; model wind is fine for advection).
    const gLat = Math.round(cLat / cfg.WEATHER_GRID_STEP) * cfg.WEATHER_GRID_STEP;
    const gLng = Math.round(cLng / cfg.WEATHER_GRID_STEP) * cfg.WEATHER_GRID_STEP;
    let wind = windStmt.get(gLat, gLng, hour);
    if (!wind) {
      // fall back to averaging wind over the member cells if present
      const ws = members.map((m) => m.wind_speed).filter((v) => v != null);
      const wd = members.map((m) => m.wind_dir).filter((v) => v != null);
      wind = {
        wind_speed: ws.length ? ws.reduce((a, b) => a + b, 0) / ws.length : 10,
        wind_dir: wd.length ? wd[0] : 270,
      };
    }

    // Magnitude: how strong + structured + seedable. Used for ranking & gating.
    const magnitude =
      (Math.min(cloudMax, 60) / 60) * 0.4 +
      Math.min(1, precipMax / 1.0) * 0.3 +
      elong * 0.15 +
      seedableMean * 0.15;

    anomalies.push({
      hour,
      center_lat: cLat,
      center_lng: cLng,
      cell_count: n,
      cloud_excess_max: cloudMax,
      precip_excess_max: precipMax,
      precip_onset: onset,
      elongation: elong,
      seedable_frac: seedableFrac,
      seedable_mean: seedableMean,
      wind_speed: wind.wind_speed,
      wind_dir: wind.wind_dir,
      baseline_kind: baselineKind,
      magnitude,
    });
  }
  return { anomalies, obsMeta: meta };
}

// ── Layer 2: candidate scoring (pure core) ────────────────────────────────────
// Score an aircraft as a candidate cause of one anomaly. Pure function over
// already-computed features so it can be unit-tested.
function scoreCandidate({ isKnownSeeder, geom, couplingKm, perp, inSeedBand, avgSpeed }) {
  let score = 0;
  const reasons = [];

  if (isKnownSeeder) { score += 35; reasons.push("known seeder"); }

  if (geom.isRacetrack) { score += 25; reasons.push("racetrack/orbit"); }
  else if (geom.isStraightPass) { score += 15; reasons.push("straight pass"); }
  else if (geom.sightings >= A.loiterMinSightings && geom.spanKm < 40) {
    score += 10; reasons.push("persistent local"); }

  if (inSeedBand) { score += 10; reasons.push("seeding altitude"); }

  if (avgSpeed != null && avgSpeed > 0 && avgSpeed < 250) { score += 5; }

  // Wind coupling: how close the aircraft was to the projected upwind point.
  if (couplingKm != null && couplingKm <= A.upwindRadiusKm) {
    const closeness = 1 - couplingKm / A.upwindRadiusKm; // 0..1
    score += Math.round(25 * closeness);
    reasons.push(`upwind match ${couplingKm.toFixed(0)}km`);
  }

  // Seeding legs run roughly perpendicular to the wind.
  if (perp != null) { score += Math.round(10 * perp); }

  // Persistence bonus
  score += Math.min(10, Math.max(0, geom.sightings - A.loiterMinSightings));

  return { score, reasons };
}

async function scoreCandidatesForAnomaly(db, anomaly) {
  const Hms = new Date(anomaly.hour + "Z").getTime();
  const windDir = anomaly.wind_dir ?? 270;
  const windKts = (anomaly.wind_speed ?? 10) * 0.868976; // mph → kts (Open-Meteo wind is mph)

  // Build the set of upwind probe points across the lag range.
  const probes = [];
  for (let lag = A.lagHoursMin; lag <= A.lagHoursMax + 1e-9; lag += A.lagHoursStep) {
    const up = geo.upwindPoint(anomaly.center_lat, anomaly.center_lng, windDir, windKts, lag);
    probes.push({ lag, lat: up.lat, lng: up.lng, tMs: Hms - lag * HOUR_MS });
  }

  // Bounding box over all probes (+ radius) to prefilter raw rows in SQL.
  const radDeg = A.upwindRadiusKm / 111;
  const minLat = Math.min(...probes.map((p) => p.lat)) - radDeg;
  const maxLat = Math.max(...probes.map((p) => p.lat)) + radDeg;
  const minLng = Math.min(...probes.map((p) => p.lng)) - radDeg / 0.6;
  const maxLng = Math.max(...probes.map((p) => p.lng)) + radDeg / 0.6;

  const tStart = isoZ(Hms - (A.lagHoursMax + 0.5) * HOUR_MS);
  const tEnd = isoZ(Hms + 0.25 * HOUR_MS);

  const rows = db
    .prepare(
      `SELECT poll_time, icao24, callsign, lat, lng, altitude_ft, speed_kts,
              heading, is_known_seeder, operator, aircraft_type
       FROM flights_seeding_alt
       WHERE poll_time >= ? AND poll_time <= ?
         AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`
    )
    .all(tStart, tEnd, minLat, maxLat, minLng, maxLng);

  // Group by airframe.
  const byAir = new Map();
  for (const r of rows) {
    const key = r.icao24 || r.callsign;
    if (!key) continue;
    if (!byAir.has(key)) byAir.set(key, []);
    byAir.get(key).push(r);
  }

  const candidates = [];
  for (const [key, pts] of byAir) {
    const geom = geo.trackGeometry(pts);
    // Best coupling: min distance from any of this airframe's fixes to the
    // upwind probe at the MATCHING lag (so the time offset is physically
    // consistent with the wind displacement).
    let bestKm = Infinity, bestLag = null;
    for (const pr of probes) {
      for (const p of pts) {
        const dtH = Math.abs(new Date(p.poll_time).getTime() - pr.tMs) / HOUR_MS;
        if (dtH > A.lagHoursStep) continue; // require the fix to match this lag's time
        const d = geo.haversineKm(p.lat, p.lng, pr.lat, pr.lng);
        if (d < bestKm) { bestKm = d; bestLag = pr.lag; }
      }
    }
    if (!isFinite(bestKm)) continue; // never near an upwind point at a consistent time

    const inSeedBand =
      geom.avgAltFt >= cfg.SEED_ALT_MIN && geom.avgAltFt <= cfg.SEED_ALT_MAX;
    const perp = geo.perpendicularityToWind(geom.meanHeading, windDir);
    const sample = pts[0];
    const cls = sample.is_known_seeder
      ? { isKnownSeeder: true, operator: sample.operator, type: sample.aircraft_type }
      : { isKnownSeeder: false, operator: sample.operator, type: sample.aircraft_type };

    const { score } = scoreCandidate({
      isKnownSeeder: cls.isKnownSeeder,
      geom,
      couplingKm: bestKm,
      perp,
      inSeedBand,
      avgSpeed: geom.avgSpeedKts,
    });

    candidates.push({
      icao24: sample.icao24 || "",
      callsign: sample.callsign || "",
      operator: sample.operator || "",
      aircraft_type: sample.aircraft_type || "",
      is_known_seeder: cls.isKnownSeeder ? 1 : 0,
      score,
      best_lag_hours: bestLag,
      coupling_km: bestKm,
      avg_alt_ft: Math.round(geom.avgAltFt),
      avg_speed_kts: Math.round(geom.avgSpeedKts),
      straightness: +geom.straightness.toFixed(3),
      is_racetrack: geom.isRacetrack ? 1 : 0,
      is_straight_pass: geom.isStraightPass ? 1 : 0,
      perpendicularity: +perp.toFixed(3),
      sightings: geom.sightings,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

// ── Legacy local signals (kept: a known seeder loitering is strong on its own) ─
function localSignals(db, hour) {
  const stats = db
    .prepare(
      `SELECT callsign, icao24, is_known_seeder, avg_alt_ft, avg_speed_kts,
              COUNT(*) sightings, MIN(lat) min_lat, MAX(lat) max_lat,
              MIN(lng) min_lng, MAX(lng) max_lng, AVG(lat) clat, AVG(lng) clng
       FROM (
         SELECT *, AVG(altitude_ft) OVER (PARTITION BY COALESCE(NULLIF(callsign,''),icao24)) avg_alt_ft,
                AVG(speed_kts) OVER (PARTITION BY COALESCE(NULLIF(callsign,''),icao24)) avg_speed_kts
         FROM flights_seeding_alt
         WHERE (substr(poll_time,1,13) || ':00:00') = ?
       )
       GROUP BY COALESCE(NULLIF(callsign,''),icao24)`
    )
    .all(hour);

  let knownSeeders = [];
  let loiters = [];
  const loiterPos = [];
  for (const s of stats) {
    if (s.is_known_seeder) knownSeeders.push(s.callsign || s.icao24);
    const spread = (s.max_lat - s.min_lat) + (s.max_lng - s.min_lng);
    if (
      s.sightings >= A.loiterMinSightings &&
      spread >= 0 && spread < A.loiterMaxSpreadDeg &&
      s.avg_speed_kts > A.loiterMinSpeedKts &&
      s.avg_alt_ft >= cfg.SEED_ALT_MIN && s.avg_alt_ft <= cfg.SEED_ALT_MAX
    ) {
      loiters.push(s.callsign || s.icao24);
      loiterPos.push({ lat: s.clat, lng: s.clng });
    }
  }
  return { knownSeeders, loiters, loiterPos };
}

// ── Orchestration: detect, score, preserve, compact ───────────────────────────
async function runMaintenance(db, registry, now = new Date()) {
  const log = [];
  const compactCutoff = isoZ(now.getTime() - cfg.RAW_RETENTION_HOURS * HOUR_MS);

  const hoursToCompact = db
    .prepare(
      `SELECT DISTINCT (substr(poll_time,1,13) || ':00:00') hour
       FROM flights_seeding_alt WHERE poll_time < ? ORDER BY hour`
    )
    .all(compactCutoff)
    .map((r) => r.hour);

  // Statements
  const insAnomaly = db.prepare(
    `INSERT INTO weather_anomalies
       (hour, center_lat, center_lng, cell_count, cloud_excess_max, precip_excess_max,
        precip_onset, elongation, seedable_frac, wind_speed, wind_dir, baseline_kind, magnitude)
     VALUES (@hour,@center_lat,@center_lng,@cell_count,@cloud_excess_max,@precip_excess_max,
        @precip_onset,@elongation,@seedable_frac,@wind_speed,@wind_dir,@baseline_kind,@magnitude)`
  );
  const insCand = db.prepare(
    `INSERT INTO anomaly_candidates
       (anomaly_id, hour, icao24, callsign, operator, aircraft_type, is_known_seeder,
        score, best_lag_hours, coupling_km, avg_alt_ft, avg_speed_kts, straightness,
        is_racetrack, is_straight_pass, perpendicularity, sightings)
     VALUES (@anomaly_id,@hour,@icao24,@callsign,@operator,@aircraft_type,@is_known_seeder,
        @score,@best_lag_hours,@coupling_km,@avg_alt_ft,@avg_speed_kts,@straightness,
        @is_racetrack,@is_straight_pass,@perpendicularity,@sightings)`
  );
  const anomalyExists = db.prepare("SELECT 1 FROM weather_anomalies WHERE hour = ? LIMIT 1");

  const insEvent = db.prepare(
    `INSERT INTO preservation_events
       (hour, context_start, context_end, center_lat, center_lng, radius_deg, score,
        known_seeder_present, loiter_callsigns, loiter_count, cloud_delta_max,
        precip_onset, cluster_count, total_aircraft_preserved, total_rows_preserved, reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insPreserved = db.prepare(
    `INSERT OR IGNORE INTO preserved_flight_detail
       (event_id, poll_time, icao24, callsign, lat, lng, altitude_ft, speed_kts,
        heading, vertical_rate, squawk, is_known_seeder, operator, aircraft_type)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insHourly = db.prepare(
    `INSERT OR REPLACE INTO flight_hourly_detail
       (hour, callsign, icao24, is_known_seeder, operator, aircraft_type,
        min_lat, max_lat, min_lng, max_lng, avg_lat, avg_lng,
        min_alt_ft, max_alt_ft, avg_alt_ft, avg_speed_kts, avg_heading, sightings)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const eventExists = db.prepare("SELECT 1 FROM preservation_events WHERE hour = ? LIMIT 1");

  let anomalyCount = 0, candidateCount = 0, preservedEvents = 0;
  const preserveQueue = [];

  // ── PHASE 1: per-hour anomaly detection + candidate scoring + event scoring ─
  for (const hour of hoursToCompact) {
    // Idempotent: detect anomalies for an hour at most once. On a re-run we load
    // what we already stored so candidate scoring / preservation stay consistent.
    let hourAnomalies = [];
    if (!anomalyExists.get(hour)) {
      const { anomalies } = await detectAnomaliesForHour(db, hour);
      const tx = db.transaction(() => {
        for (const an of anomalies) {
          const res = insAnomaly.run({
            hour: an.hour,
            center_lat: an.center_lat,
            center_lng: an.center_lng,
            cell_count: an.cell_count,
            cloud_excess_max: an.cloud_excess_max,
            precip_excess_max: an.precip_excess_max,
            precip_onset: an.precip_onset,
            elongation: an.elongation,
            seedable_frac: an.seedable_frac,
            wind_speed: an.wind_speed,
            wind_dir: an.wind_dir,
            baseline_kind: an.baseline_kind,
            magnitude: an.magnitude,
          });
          an.id = res.lastInsertRowid; // remember the row id for candidate linking
          anomalyCount++;
        }
      });
      tx();
      hourAnomalies = anomalies;
    } else {
      hourAnomalies = db.prepare("SELECT * FROM weather_anomalies WHERE hour = ?").all(hour);
    }

    const sig = localSignals(db, hour);

    // Score candidates per anomaly; persist the top ones (raw flights still here).
    let bestCandidateScore = 0;
    for (const an of hourAnomalies) {
      if (an.id == null) continue;
      const cands = await scoreCandidatesForAnomaly(db, an);
      if (!cands.length) continue;
      const top = cands.slice(0, 25);
      const tx = db.transaction(() => {
        for (const c of top) insCand.run({ ...c, anomaly_id: an.id, hour });
      });
      tx();
      candidateCount += top.length;
      bestCandidateScore = Math.max(bestCandidateScore, top[0].score);
    }

    const bestAnomalyMag = hourAnomalies.reduce((m, a) => Math.max(m, a.magnitude || 0), 0);
    const bestSeedable = hourAnomalies.reduce(
      (m, a) => Math.max(m, a.seedable_mean ?? a.seedable_frac ?? 0), 0
    );

    // ── Preservation score for the hour ──────────────────────────────────────
    let score = 0;
    const reasons = [];
    if (sig.knownSeeders.length) {
      score += 40;
      reasons.push(`${sig.knownSeeders.length} known seeder(s): ${sig.knownSeeders.join(", ")}`);
    }
    if (sig.loiters.length) {
      score += 25;
      reasons.push(`loiter: ${sig.loiters.join(", ")}`);
    }
    if (hourAnomalies.length) {
      score += Math.round(40 * bestAnomalyMag * Math.max(0.25, bestSeedable));
      reasons.push(`seedable anomaly (mag ${bestAnomalyMag.toFixed(2)}, seedable ${bestSeedable.toFixed(2)})`);
    }
    if (bestCandidateScore > 0) {
      score += Math.min(30, Math.round(bestCandidateScore * 0.4));
      reasons.push(`best wind-coupled candidate ${bestCandidateScore}`);
    }

    const hasLocalSignal =
      sig.knownSeeders.length > 0 ||
      sig.loiters.length > 0 ||
      (bestCandidateScore >= 55 && bestSeedable >= 0.4);

    if (score >= A.preserveThreshold && hasLocalSignal && !eventExists.get(hour)) {
      let center = null;
      if (sig.loiterPos.length) {
        center = {
          lat: sig.loiterPos.reduce((s, p) => s + p.lat, 0) / sig.loiterPos.length,
          lng: sig.loiterPos.reduce((s, p) => s + p.lng, 0) / sig.loiterPos.length,
        };
      } else if (hourAnomalies.length) {
        const strongest = hourAnomalies.reduce((a, b) =>
          (b.magnitude || 0) > (a.magnitude || 0) ? b : a
        );
        center = { lat: strongest.center_lat, lng: strongest.center_lng };
      }
      preserveQueue.push({
        hour,
        score,
        center,
        reason: reasons.join("; "),
        knownSeederPresent: sig.knownSeeders.length,
        loiters: sig.loiters,
        cloudDeltaMax: hourAnomalies.reduce((m, a) => Math.max(m, a.cloud_excess_max || 0), 0),
        precipOnset: hourAnomalies.some((a) => a.precip_onset) ? 1 : 0,
        clusterCount: hourAnomalies.length,
      });
    }
  }

  // ── PHASE 2: preservation (bounded copy) + compaction ──────────────────────
  const preserveTx = db.transaction(() => {
    for (const q of preserveQueue) {
      if (eventExists.get(q.hour)) continue;
      const baseMs = new Date(q.hour + "Z").getTime();
      const ctxStart = isoZ(baseMs - A.contextHoursBefore * HOUR_MS);
      const ctxEnd = isoZ(baseMs + (A.contextHoursAfter + 1) * HOUR_MS);
      const haveCenter = q.center && q.center.lat != null;
      const RAD = A.preserveRadiusDeg;

      const rows = haveCenter
        ? db.prepare(
            `SELECT poll_time, icao24, callsign, lat, lng, altitude_ft, speed_kts,
                    heading, vertical_rate, squawk, is_known_seeder, operator, aircraft_type
             FROM flights_seeding_alt
             WHERE poll_time >= ? AND poll_time < ?
               AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`
          ).all(ctxStart, ctxEnd, q.center.lat - RAD, q.center.lat + RAD, q.center.lng - RAD, q.center.lng + RAD)
        : db.prepare(
            `SELECT poll_time, icao24, callsign, lat, lng, altitude_ft, speed_kts,
                    heading, vertical_rate, squawk, is_known_seeder, operator, aircraft_type
             FROM flights_seeding_alt
             WHERE poll_time >= ? AND poll_time < ? AND is_known_seeder = 1`
          ).all(ctxStart, ctxEnd);

      const aircraft = new Set(rows.map((r) => r.callsign || r.icao24));
      const res = insEvent.run(
        q.hour, ctxStart, ctxEnd,
        haveCenter ? q.center.lat : null,
        haveCenter ? q.center.lng : null,
        RAD, q.score, q.knownSeederPresent,
        q.loiters.join(","), q.loiters.length,
        q.cloudDeltaMax, q.precipOnset, q.clusterCount,
        aircraft.size, rows.length, q.reason
      );
      const eventId = res.lastInsertRowid;
      for (const r of rows) {
        insPreserved.run(
          eventId, r.poll_time, r.icao24, r.callsign, r.lat, r.lng, r.altitude_ft,
          r.speed_kts, r.heading, r.vertical_rate, r.squawk, r.is_known_seeder,
          r.operator, r.aircraft_type
        );
      }
      preservedEvents++;
      log.push(`★ preserved ${q.hour} (score ${q.score}): ${q.reason}`);
    }

    // Compact every hour to hourly summaries (dedup by airframe key).
    for (const hour of hoursToCompact) {
      const rows = db
        .prepare(
          `SELECT COALESCE(NULLIF(callsign,''),icao24) AS k,
                  MAX(callsign) callsign, MAX(icao24) icao24,
                  MAX(is_known_seeder) is_known_seeder, MAX(operator) operator,
                  MAX(aircraft_type) aircraft_type,
                  MIN(lat) min_lat, MAX(lat) max_lat, MIN(lng) min_lng, MAX(lng) max_lng,
                  AVG(lat) avg_lat, AVG(lng) avg_lng,
                  MIN(altitude_ft) min_alt, MAX(altitude_ft) max_alt, AVG(altitude_ft) avg_alt,
                  AVG(speed_kts) avg_speed, AVG(heading) avg_heading, COUNT(*) sightings
           FROM flights_seeding_alt
           WHERE (substr(poll_time,1,13) || ':00:00') = ?
           GROUP BY k`
        )
        .all(hour);
      for (const r of rows) {
        insHourly.run(
          hour, r.callsign || r.k, r.icao24, r.is_known_seeder, r.operator, r.aircraft_type,
          r.min_lat, r.max_lat, r.min_lng, r.max_lng, r.avg_lat, r.avg_lng,
          r.min_alt, r.max_alt, r.avg_alt, r.avg_speed, r.avg_heading, r.sightings
        );
      }
    }

    db.prepare("DELETE FROM flights_seeding_alt WHERE poll_time < ?").run(compactCutoff);
  });
  preserveTx();

  return {
    hoursCompacted: hoursToCompact.length,
    anomalyCount,
    candidateCount,
    preservedEvents,
    log,
  };
}

module.exports = {
  seedabilityScore,
  clusterCells,
  elongation,
  scoreCandidate,
  detectAnomaliesForHour,
  scoreCandidatesForAnomaly,
  localSignals,
  runMaintenance,
};
