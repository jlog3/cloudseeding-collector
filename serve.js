#!/usr/bin/env node
// ─── DATA API SERVER ────────────────────────────────────────────────────────
// Read-only REST API over the CONUS-wide collector database.
// Usage: PORT=4000 node serve.js

const Database = require("better-sqlite3");
const express = require("express");
const cors = require("cors");
const path = require("path");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "cloudseeding.db");
const PORT = parseInt(process.env.PORT || "4000");

const db = new Database(DB_PATH, { readonly: true });
db.pragma("journal_mode = WAL");

const app = express();
app.use(cors());

// ─── GET /api/weather?lat=39.87&lng=-75.31&hours=24 ─────────────────────────
// Returns hourly weather for the nearest grid point.
app.get("/api/weather", (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const hours = parseInt(req.query.hours || "24");
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: "lat and lng required" });

  // Snap to nearest grid point
  const gridLat = Math.round(lat / 2) * 2;
  const gridLng = Math.round(lng / 2) * 2;
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();

  const rows = db.prepare(`
    SELECT timestamp, temperature, humidity, wind_speed, wind_dir,
      precip_rate, precip_prob, cloud_cover, cloud_cover_low,
      cloud_cover_mid, cloud_cover_high, pressure, dewpoint, visibility
    FROM weather_grid
    WHERE grid_lat = ? AND grid_lng = ? AND timestamp >= ?
    ORDER BY timestamp ASC
  `).all(gridLat, gridLng, cutoff);

  res.json({
    grid_point: { lat: gridLat, lng: gridLng },
    requested: { lat, lng },
    hours: rows.length,
    data: rows,
  });
});

// ─── GET /api/flights?lat=39.87&lng=-75.31&radius=2&hours=48 ────────────────
// Returns seeding-altitude flight detail within a radius (last 48h).
app.get("/api/flights", (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const radius = parseFloat(req.query.radius || "2"); // degrees
  const hours = Math.min(48, parseInt(req.query.hours || "24"));
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: "lat and lng required" });

  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();

  const rows = db.prepare(`
    SELECT poll_time, icao24, callsign, lat, lng, altitude_ft,
      speed_kts, heading, vertical_rate, squawk, is_known_seeder, operator, aircraft_type
    FROM flights_seeding_alt
    WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
      AND poll_time >= ?
    ORDER BY poll_time ASC
  `).all(lat - radius, lat + radius, lng - radius, lng + radius, cutoff);

  // Group by poll_time
  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.poll_time]) grouped[row.poll_time] = { time: row.poll_time, flights: [], seeders: 0 };
    grouped[row.poll_time].flights.push(row);
    if (row.is_known_seeder) grouped[row.poll_time].seeders++;
  }

  res.json({
    center: { lat, lng }, radius, hours,
    snapshots: Object.keys(grouped).length,
    total_rows: rows.length,
    data: Object.values(grouped),
  });
});

// ─── GET /api/flights/history?lat=39.87&lng=-75.31&radius=2&days=30 ─────────
// Returns compacted hourly flight data (for historical correlation).
app.get("/api/flights/history", (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const radius = parseFloat(req.query.radius || "2");
  const days = parseInt(req.query.days || "7");
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: "lat and lng required" });

  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  const rows = db.prepare(`
    SELECT hour, callsign, icao24, is_known_seeder, operator, aircraft_type,
      avg_lat, avg_lng, min_alt_ft, max_alt_ft, avg_alt_ft,
      avg_speed_kts, sightings
    FROM flight_hourly_detail
    WHERE avg_lat BETWEEN ? AND ? AND avg_lng BETWEEN ? AND ?
      AND hour >= ?
    ORDER BY hour ASC, callsign
  `).all(lat - radius, lat + radius, lng - radius, lng + radius, cutoff);

  res.json({
    center: { lat, lng }, radius, days,
    callsign_hours: rows.length,
    unique_callsigns: new Set(rows.map(r => r.callsign)).size,
    seeders_found: rows.filter(r => r.is_known_seeder).length,
    data: rows,
  });
});

// ─── GET /api/seeders?hours=168 (default 7 days) ───────────────────────────
// All known seeder positions, full detail, forever.
app.get("/api/seeders", (req, res) => {
  const hours = parseInt(req.query.hours || "168");
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();

  const rows = db.prepare(`
    SELECT poll_time, callsign, lat, lng, altitude_ft,
      speed_kts, heading, vertical_rate, operator, aircraft_type
    FROM seeder_tracks
    WHERE poll_time >= ?
    ORDER BY poll_time DESC
  `).all(cutoff);

  res.json({ hours, sightings: rows.length, data: rows });
});

// ─── GET /api/traffic?hours=168 ─────────────────────────────────────────────
// CONUS-wide hourly traffic totals.
app.get("/api/traffic", (req, res) => {
  const hours = parseInt(req.query.hours || "168");
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();

  const rows = db.prepare(`
    SELECT hour, total_aircraft, seeding_alt_aircraft, high_alt_aircraft,
      low_alt_aircraft, known_seeder_count, known_seeder_callsigns
    FROM traffic_hourly_summary
    WHERE hour >= ?
    ORDER BY hour ASC
  `).all(cutoff);

  res.json({ hours, entries: rows.length, data: rows });
});

// ─── GET /api/events?days=30 ────────────────────────────────────────────────
// List all detected preservation events (seeding-indicative patterns).
app.get("/api/events", (req, res) => {
  const days = parseInt(req.query.days || "30");
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  const rows = db.prepare(`
    SELECT id, detected_at, hour, context_start, context_end, score,
      known_seeder_present, loiter_callsigns, loiter_count,
      cloud_delta_max, precip_onset, cluster_count,
      total_aircraft_preserved, total_rows_preserved, reason
    FROM preservation_events
    WHERE detected_at >= ?
    ORDER BY score DESC, detected_at DESC
  `).all(cutoff);

  res.json({ days, events: rows.length, data: rows });
});

// ─── GET /api/events/:id ────────────────────────────────────────────────────
// Get full flight detail for a specific preserved event.
app.get("/api/events/:id", (req, res) => {
  const eventId = parseInt(req.params.id);
  if (isNaN(eventId)) return res.status(400).json({ error: "Invalid event ID" });

  const event = db.prepare(`
    SELECT * FROM preservation_events WHERE id = ?
  `).get(eventId);

  if (!event) return res.status(404).json({ error: "Event not found" });

  const flights = db.prepare(`
    SELECT poll_time, icao24, callsign, lat, lng, altitude_ft,
      speed_kts, heading, vertical_rate, squawk,
      is_known_seeder, operator, aircraft_type
    FROM preserved_flight_detail
    WHERE event_id = ?
    ORDER BY poll_time ASC, callsign
  `).all(eventId);

  // Group by callsign for per-aircraft tracks
  const tracks = {};
  for (const f of flights) {
    if (!tracks[f.callsign]) {
      tracks[f.callsign] = {
        callsign: f.callsign,
        icao24: f.icao24,
        is_known_seeder: f.is_known_seeder,
        operator: f.operator,
        aircraft_type: f.aircraft_type,
        positions: [],
      };
    }
    tracks[f.callsign].positions.push({
      time: f.poll_time,
      lat: f.lat, lng: f.lng,
      altitude_ft: f.altitude_ft,
      speed_kts: f.speed_kts,
      heading: f.heading,
      vertical_rate: f.vertical_rate,
    });
  }

  // Get weather for the event's time window at nearby grid points
  const weather = db.prepare(`
    SELECT timestamp, grid_lat, grid_lng, cloud_cover, cloud_cover_low,
      cloud_cover_mid, cloud_cover_high, precip_rate, precip_prob,
      humidity, temperature, wind_speed, wind_dir
    FROM weather_grid
    WHERE timestamp BETWEEN ? AND ?
    ORDER BY timestamp, grid_lat, grid_lng
  `).all(event.context_start, event.context_end);

  res.json({
    event,
    flight_rows: flights.length,
    unique_aircraft: Object.keys(tracks).length,
    tracks: Object.values(tracks),
    weather_context: weather,
  });
});

// ─── GET /api/correlate?lat=39.87&lng=-75.31&hours=24 ──────────────────────
// The key endpoint: returns weather + flight data aligned by hour for a location.
// This is what the dashboard's correlation engine consumes.
app.get("/api/correlate", (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const hours = parseInt(req.query.hours || "24");
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: "lat and lng required" });

  const gridLat = Math.round(lat / 2) * 2;
  const gridLng = Math.round(lng / 2) * 2;
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();

  // Weather by hour
  const weather = db.prepare(`
    SELECT timestamp as hour, cloud_cover, cloud_cover_low, cloud_cover_mid,
      cloud_cover_high, precip_rate, precip_prob, humidity, temperature,
      wind_speed, wind_dir
    FROM weather_grid
    WHERE grid_lat = ? AND grid_lng = ? AND timestamp >= ?
    ORDER BY timestamp
  `).all(gridLat, gridLng, cutoff);

  // Flight summaries by hour (compacted + recent)
  const flightHourly = db.prepare(`
    SELECT hour, callsign, is_known_seeder, avg_alt_ft, sightings
    FROM flight_hourly_detail
    WHERE avg_lat BETWEEN ? AND ? AND avg_lng BETWEEN ? AND ?
      AND hour >= ?
    ORDER BY hour
  `).all(lat - 2, lat + 2, lng - 2, lng + 2, cutoff);

  // Group flights by hour
  const flightsByHour = {};
  for (const f of flightHourly) {
    if (!flightsByHour[f.hour]) flightsByHour[f.hour] = { total: 0, seeders: 0, callsigns: [] };
    flightsByHour[f.hour].total++;
    if (f.is_known_seeder) {
      flightsByHour[f.hour].seeders++;
      flightsByHour[f.hour].callsigns.push(f.callsign);
    }
  }

  // Merge into timeline
  const timeline = weather.map((w) => ({
    ...w,
    flights_total: flightsByHour[w.hour]?.total || 0,
    flights_seeders: flightsByHour[w.hour]?.seeders || 0,
    seeder_callsigns: flightsByHour[w.hour]?.callsigns || [],
  }));

  res.json({
    grid_point: { lat: gridLat, lng: gridLng },
    requested: { lat, lng },
    hours: timeline.length,
    data: timeline,
  });
});

// ─── GET /api/stats ─────────────────────────────────────────────────────────
app.get("/api/stats", (req, res) => {
  const get = (q) => db.prepare(q).get();
  const pageCount = db.pragma("page_count", { simple: true });
  const pageSize = db.pragma("page_size", { simple: true });

  res.json({
    db_size_mb: ((pageCount * pageSize) / 1048576).toFixed(1),
    weather_grid_rows: get("SELECT COUNT(*) as n FROM weather_grid").n,
    flight_detail_rows: get("SELECT COUNT(*) as n FROM flights_seeding_alt").n,
    flight_hourly_rows: get("SELECT COUNT(*) as n FROM flight_hourly_detail").n,
    seeder_track_rows: get("SELECT COUNT(*) as n FROM seeder_tracks").n,
    traffic_summary_rows: get("SELECT COUNT(*) as n FROM traffic_hourly_summary").n,
    preserved_flight_rows: get("SELECT COUNT(*) as n FROM preserved_flight_detail").n,
    preservation_events: get("SELECT COUNT(*) as n FROM preservation_events").n,
    highest_event_score: get("SELECT MAX(score) as n FROM preservation_events").n || 0,
    oldest_weather: get("SELECT MIN(timestamp) as t FROM weather_grid").t,
    newest_weather: get("SELECT MAX(timestamp) as t FROM weather_grid").t,
    oldest_flight: get("SELECT MIN(poll_time) as t FROM flights_seeding_alt").t,
    newest_flight: get("SELECT MAX(poll_time) as t FROM flights_seeding_alt").t,
    unique_callsigns_compacted: get("SELECT COUNT(DISTINCT callsign) as n FROM flight_hourly_detail").n,
  });
});

app.listen(PORT, () => {
  console.log(`CloudSeeding CONUS Data API on http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Key endpoints:`);
  console.log(`  GET /api/correlate?lat=39.87&lng=-75.31&hours=24  ← dashboard uses this`);
  console.log(`  GET /api/flights?lat=39.87&lng=-75.31&hours=48    ← recent detail`);
  console.log(`  GET /api/flights/history?lat=39.87&lng=-75.31&days=30`);
  console.log(`  GET /api/weather?lat=39.87&lng=-75.31&hours=24`);
  console.log(`  GET /api/events?days=30                           ← preserved seeding events`);
  console.log(`  GET /api/events/:id                               ← full flight tracks for event`);
  console.log(`  GET /api/seeders?hours=168`);
  console.log(`  GET /api/traffic?hours=168`);
  console.log(`  GET /api/stats`);
});
