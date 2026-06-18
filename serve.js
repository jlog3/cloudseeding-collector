#!/usr/bin/env node
// ─── DATA API SERVER (v2) ───────────────────────────────────────────────────
// Read-only REST API over the collector DB.
//
// BACKWARD COMPATIBLE: every endpoint the website already calls (/api/correlate,
// /api/flights, /api/flights/history, /api/weather, /api/seeders, /api/traffic,
// /api/events, /api/events/:id, /api/stats) is unchanged.
//
// NEW (the layered detector's output):
//   GET /api/anomalies            – forecast-exceedance anomalies (seedable-gated)
//   GET /api/anomalies/:id        – one anomaly + ranked candidate aircraft
//   GET /api/candidates           – wind-coupled candidates (by airframe or top)
//   GET /api/airframes            – the aggregate "repeat offender" ranking
//   GET /api/seeders/registry     – the icao24-keyed known-seeder list

const Database = require("better-sqlite3");
const express = require("express");
const cors = require("cors");
const cfg = require("./config");

const DB_PATH = cfg.DB_PATH;
const PORT = parseInt(process.env.PORT || "4000");

const db = new Database(DB_PATH, { readonly: true });
db.pragma("journal_mode = WAL");

const app = express();
app.use(cors());

const STEP = cfg.WEATHER_GRID_STEP;
const snapGrid = (v) => Math.round(v / STEP) * STEP;

// ════ EXISTING ENDPOINTS (unchanged behavior) ════════════════════════════════

app.get("/api/weather", (req, res) => {
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  const hours = parseInt(req.query.hours || "24");
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: "lat and lng required" });
  const gridLat = snapGrid(lat), gridLng = snapGrid(lng);
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString().slice(0, 13) + ":00:00";
  const rows = db.prepare(`
    SELECT timestamp, temperature, humidity, wind_speed, wind_dir, precip_rate,
      precip_prob, cloud_cover, cloud_cover_low, cloud_cover_mid, cloud_cover_high,
      pressure, dewpoint, visibility
    FROM weather_grid WHERE grid_lat = ? AND grid_lng = ? AND timestamp >= ?
    ORDER BY timestamp ASC`).all(gridLat, gridLng, cutoff);
  res.json({ grid_point: { lat: gridLat, lng: gridLng }, requested: { lat, lng }, hours: rows.length, data: rows });
});

app.get("/api/flights", (req, res) => {
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  const radius = parseFloat(req.query.radius || "2");
  const hours = Math.min(48, parseInt(req.query.hours || "24"));
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: "lat and lng required" });
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
  const rows = db.prepare(`
    SELECT poll_time, icao24, callsign, lat, lng, altitude_ft, speed_kts, heading,
      vertical_rate, squawk, is_known_seeder, operator, aircraft_type
    FROM flights_seeding_alt
    WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? AND poll_time >= ?
    ORDER BY poll_time ASC`).all(lat - radius, lat + radius, lng - radius, lng + radius, cutoff);
  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.poll_time]) grouped[row.poll_time] = { time: row.poll_time, flights: [], seeders: 0 };
    grouped[row.poll_time].flights.push(row);
    if (row.is_known_seeder) grouped[row.poll_time].seeders++;
  }
  res.json({ center: { lat, lng }, radius, hours, snapshots: Object.keys(grouped).length, total_rows: rows.length, data: Object.values(grouped) });
});

app.get("/api/flights/history", (req, res) => {
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  const radius = parseFloat(req.query.radius || "2");
  const days = parseInt(req.query.days || "7");
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: "lat and lng required" });
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 13) + ":00:00";
  const rows = db.prepare(`
    SELECT hour, callsign, icao24, is_known_seeder, operator, aircraft_type,
      avg_lat, avg_lng, min_alt_ft, max_alt_ft, avg_alt_ft, avg_speed_kts, sightings
    FROM flight_hourly_detail
    WHERE avg_lat BETWEEN ? AND ? AND avg_lng BETWEEN ? AND ? AND hour >= ?
    ORDER BY hour ASC, callsign`).all(lat - radius, lat + radius, lng - radius, lng + radius, cutoff);
  res.json({ center: { lat, lng }, radius, days, callsign_hours: rows.length,
    unique_callsigns: new Set(rows.map((r) => r.callsign)).size,
    seeders_found: rows.filter((r) => r.is_known_seeder).length, data: rows });
});

app.get("/api/seeders", (req, res) => {
  const hours = parseInt(req.query.hours || "168");
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
  const rows = db.prepare(`
    SELECT poll_time, callsign, lat, lng, altitude_ft, speed_kts, heading,
      vertical_rate, operator, aircraft_type
    FROM seeder_tracks WHERE poll_time >= ? ORDER BY poll_time DESC`).all(cutoff);
  res.json({ hours, sightings: rows.length, data: rows });
});

app.get("/api/traffic", (req, res) => {
  const hours = parseInt(req.query.hours || "168");
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
  const rows = db.prepare(`
    SELECT hour, total_aircraft, seeding_alt_aircraft, high_alt_aircraft,
      low_alt_aircraft, known_seeder_count, known_seeder_callsigns
    FROM traffic_hourly_summary WHERE hour >= ? ORDER BY hour ASC`).all(cutoff);
  res.json({ hours, entries: rows.length, data: rows });
});

app.get("/api/events", (req, res) => {
  const days = parseInt(req.query.days || "30");
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const rows = db.prepare(`
    SELECT id, detected_at, hour, context_start, context_end, score,
      known_seeder_present, loiter_callsigns, loiter_count, cloud_delta_max,
      precip_onset, cluster_count, total_aircraft_preserved, total_rows_preserved, reason
    FROM preservation_events WHERE detected_at >= ?
    ORDER BY score DESC, detected_at DESC`).all(cutoff);
  res.json({ days, events: rows.length, data: rows });
});

app.get("/api/events/:id", (req, res) => {
  const eventId = parseInt(req.params.id);
  if (isNaN(eventId)) return res.status(400).json({ error: "Invalid event ID" });
  const event = db.prepare("SELECT * FROM preservation_events WHERE id = ?").get(eventId);
  if (!event) return res.status(404).json({ error: "Event not found" });
  const flights = db.prepare(`
    SELECT poll_time, icao24, callsign, lat, lng, altitude_ft, speed_kts, heading,
      vertical_rate, squawk, is_known_seeder, operator, aircraft_type
    FROM preserved_flight_detail WHERE event_id = ? ORDER BY poll_time ASC, callsign`).all(eventId);
  const tracks = {};
  for (const f of flights) {
    if (!tracks[f.callsign]) tracks[f.callsign] = {
      callsign: f.callsign, icao24: f.icao24, is_known_seeder: f.is_known_seeder,
      operator: f.operator, aircraft_type: f.aircraft_type, positions: [] };
    tracks[f.callsign].positions.push({ time: f.poll_time, lat: f.lat, lng: f.lng,
      altitude_ft: f.altitude_ft, speed_kts: f.speed_kts, heading: f.heading, vertical_rate: f.vertical_rate });
  }
  const weather = db.prepare(`
    SELECT timestamp, grid_lat, grid_lng, cloud_cover, cloud_cover_low, cloud_cover_mid,
      cloud_cover_high, precip_rate, precip_prob, humidity, temperature, wind_speed, wind_dir
    FROM weather_grid WHERE timestamp BETWEEN ? AND ?
    ORDER BY timestamp, grid_lat, grid_lng`).all(event.context_start, event.context_end);
  res.json({ event, flight_rows: flights.length, unique_aircraft: Object.keys(tracks).length,
    tracks: Object.values(tracks), weather_context: weather });
});

app.get("/api/correlate", (req, res) => {
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  const radius = parseFloat(req.query.radius || "2");
  const hours = parseInt(req.query.hours || "24");
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: "lat and lng required" });
  const gridLat = snapGrid(lat), gridLng = snapGrid(lng);
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString().slice(0, 13) + ":00:00";
  const weather = db.prepare(`
    SELECT timestamp as hour, cloud_cover, cloud_cover_low, cloud_cover_mid, cloud_cover_high,
      precip_rate, precip_prob, humidity, temperature, wind_speed, wind_dir
    FROM weather_grid WHERE grid_lat = ? AND grid_lng = ? AND timestamp >= ? ORDER BY timestamp`
  ).all(gridLat, gridLng, cutoff);
  const flightHourly = db.prepare(`
    SELECT hour, callsign, is_known_seeder, avg_alt_ft, sightings FROM flight_hourly_detail
    WHERE avg_lat BETWEEN ? AND ? AND avg_lng BETWEEN ? AND ? AND hour >= ? ORDER BY hour`
  ).all(lat - radius, lat + radius, lng - radius, lng + radius, cutoff);
  const byHour = {};
  for (const f of flightHourly) {
    if (!byHour[f.hour]) byHour[f.hour] = { total: 0, seeders: 0, callsigns: [] };
    byHour[f.hour].total++;
    if (f.is_known_seeder) { byHour[f.hour].seeders++; byHour[f.hour].callsigns.push(f.callsign); }
  }
  const timeline = weather.map((w) => ({ ...w,
    flights_total: byHour[w.hour]?.total || 0,
    flights_seeders: byHour[w.hour]?.seeders || 0,
    seeder_callsigns: byHour[w.hour]?.callsigns || [] }));
  res.json({ grid_point: { lat: gridLat, lng: gridLng }, requested: { lat, lng }, hours: timeline.length, data: timeline });
});

// ════ NEW ENDPOINTS ══════════════════════════════════════════════════════════

// Anomalies (forecast-exceedance, seedable-gated). Optional ?seedable=0.4 filter
// and geographic box (?lat&lng&radius).
app.get("/api/anomalies", (req, res) => {
  const days = parseInt(req.query.days || "30");
  const seedable = req.query.seedable != null ? parseFloat(req.query.seedable) : null;
  const limit = Math.min(1000, parseInt(req.query.limit || "300"));
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19);
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  const radius = parseFloat(req.query.radius || "3");
  const hasBox = !isNaN(lat) && !isNaN(lng);

  const where = ["hour >= ?"];
  const args = [cutoff];
  if (seedable != null) { where.push("seedable_frac >= ?"); args.push(seedable); }
  if (hasBox) { where.push("center_lat BETWEEN ? AND ? AND center_lng BETWEEN ? AND ?");
    args.push(lat - radius, lat + radius, lng - radius, lng + radius); }

  const rows = db.prepare(`
    SELECT a.*, (SELECT COUNT(*) FROM anomaly_candidates c WHERE c.anomaly_id = a.id) candidate_count,
      (SELECT MAX(score) FROM anomaly_candidates c WHERE c.anomaly_id = a.id) top_candidate_score
    FROM weather_anomalies a WHERE ${where.join(" AND ")}
    ORDER BY a.magnitude DESC, a.hour DESC LIMIT ?`).all(...args, limit);
  res.json({ days, count: rows.length, data: rows });
});

app.get("/api/anomalies/:id", (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid anomaly ID" });
  const anomaly = db.prepare("SELECT * FROM weather_anomalies WHERE id = ?").get(id);
  if (!anomaly) return res.status(404).json({ error: "Anomaly not found" });
  const candidates = db.prepare(`
    SELECT icao24, callsign, operator, aircraft_type, is_known_seeder, score,
      best_lag_hours, coupling_km, avg_alt_ft, avg_speed_kts, straightness,
      is_racetrack, is_straight_pass, perpendicularity, sightings
    FROM anomaly_candidates WHERE anomaly_id = ? ORDER BY score DESC`).all(id);
  res.json({ anomaly, candidate_count: candidates.length, candidates });
});

// Candidates: by airframe (?icao24=) over a window, else the top-scoring recent.
app.get("/api/candidates", (req, res) => {
  const days = parseInt(req.query.days || "30");
  const limit = Math.min(1000, parseInt(req.query.limit || "200"));
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19);
  const icao24 = (req.query.icao24 || "").toLowerCase();
  if (icao24) {
    const rows = db.prepare(`
      SELECT c.*, a.center_lat, a.center_lng, a.seedable_frac, a.magnitude
      FROM anomaly_candidates c JOIN weather_anomalies a ON a.id = c.anomaly_id
      WHERE c.icao24 = ? AND c.hour >= ? ORDER BY c.hour DESC LIMIT ?`).all(icao24, cutoff, limit);
    return res.json({ icao24, days, count: rows.length, data: rows });
  }
  const rows = db.prepare(`
    SELECT c.*, a.center_lat, a.center_lng, a.seedable_frac, a.magnitude
    FROM anomaly_candidates c JOIN weather_anomalies a ON a.id = c.anomaly_id
    WHERE c.hour >= ? ORDER BY c.score DESC LIMIT ?`).all(cutoff, limit);
  res.json({ days, count: rows.length, data: rows });
});

// The headline: aggregate "repeat offender" ranking. ?significant=1 to filter to
// FDR-significant airframes; default sorts by excess (associations beyond what
// flight volume predicts).
app.get("/api/airframes", (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit || "50"));
  const onlySig = req.query.significant === "1";
  const minAssoc = parseInt(req.query.min_associations || "0");
  const rows = db.prepare(`
    SELECT icao24, callsign, operator, aircraft_type, is_known_seeder, associations,
      expected, excess, z, p_value, fdr_q, significant, active_hours,
      mean_candidate_score, updated_at
    FROM airframe_scores
    WHERE associations >= ? ${onlySig ? "AND significant = 1" : ""}
    ORDER BY excess DESC, associations DESC LIMIT ?`).all(minAssoc, limit);
  const meta = db.prepare("SELECT MAX(updated_at) updated_at, COUNT(*) n FROM airframe_scores").get();
  res.json({
    note: "Candidates ranked by associations beyond flight-volume expectation. " +
      "Higher excess / significant=1 = worth a human look. NOT a determination of seeding.",
    last_computed: meta.updated_at, total_ranked: meta.n, count: rows.length, data: rows });
});

app.get("/api/seeders/registry", (req, res) => {
  const rows = db.prepare(`
    SELECT icao24, registration, operator, aircraft_type, source, added_at
    FROM seeder_registry ORDER BY operator, registration`).all();
  const byOp = {};
  for (const r of rows) byOp[r.operator] = (byOp[r.operator] || 0) + 1;
  res.json({ count: rows.length, by_operator: byOp, data: rows });
});

// ════ STATS ══════════════════════════════════════════════════════════════════
app.get("/api/stats", (req, res) => {
  const get = (q) => { try { return db.prepare(q).get(); } catch { return { n: -1 }; } };
  const pageCount = db.pragma("page_count", { simple: true });
  const pageSize = db.pragma("page_size", { simple: true });
  res.json({
    db_size_mb: ((pageCount * pageSize) / 1048576).toFixed(1),
    weather_grid_rows: get("SELECT COUNT(*) n FROM weather_grid").n,
    weather_forecast_rows: get("SELECT COUNT(*) n FROM weather_forecast").n,
    flight_detail_rows: get("SELECT COUNT(*) n FROM flights_seeding_alt").n,
    flight_hourly_rows: get("SELECT COUNT(*) n FROM flight_hourly_detail").n,
    seeder_track_rows: get("SELECT COUNT(*) n FROM seeder_tracks").n,
    seeder_registry_rows: get("SELECT COUNT(*) n FROM seeder_registry").n,
    traffic_summary_rows: get("SELECT COUNT(*) n FROM traffic_hourly_summary").n,
    anomaly_rows: get("SELECT COUNT(*) n FROM weather_anomalies").n,
    seedable_anomaly_rows: get("SELECT COUNT(*) n FROM weather_anomalies WHERE seedable_frac >= 0.4").n,
    candidate_rows: get("SELECT COUNT(*) n FROM anomaly_candidates").n,
    airframe_scores_rows: get("SELECT COUNT(*) n FROM airframe_scores").n,
    flagged_airframes: get("SELECT COUNT(*) n FROM airframe_scores WHERE significant = 1").n,
    preserved_flight_rows: get("SELECT COUNT(*) n FROM preserved_flight_detail").n,
    preservation_events: get("SELECT COUNT(*) n FROM preservation_events").n,
    highest_event_score: get("SELECT MAX(score) n FROM preservation_events").n || 0,
    oldest_weather: get("SELECT MIN(timestamp) t FROM weather_grid").t,
    newest_weather: get("SELECT MAX(timestamp) t FROM weather_grid").t,
    oldest_flight: get("SELECT MIN(poll_time) t FROM flights_seeding_alt").t,
    newest_flight: get("SELECT MAX(poll_time) t FROM flights_seeding_alt").t,
    unique_callsigns_compacted: get("SELECT COUNT(DISTINCT callsign) n FROM flight_hourly_detail").n,
  });
});

app.listen(PORT, () => {
  console.log(`CloudSeeding CONUS Data API on http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Key endpoints:`);
  console.log(`  GET /api/correlate?lat=39.87&lng=-75.31&hours=24   ← dashboard uses this`);
  console.log(`  GET /api/flights?lat=..&lng=..&hours=48`);
  console.log(`  GET /api/anomalies?days=30&seedable=0.4            ← forecast-exceedance events`);
  console.log(`  GET /api/anomalies/:id                             ← anomaly + ranked candidates`);
  console.log(`  GET /api/candidates?icao24=ab1234                  ← an airframe's coupling history`);
  console.log(`  GET /api/airframes?significant=1                   ← suspected repeat offenders`);
  console.log(`  GET /api/seeders/registry                          ← known seeders (icao24)`);
  console.log(`  GET /api/events?days=30 | /api/events/:id | /api/stats`);
});
