// ─── WEATHER ACQUISITION (BASELINE LAYER) ───────────────────────────────────
// Open-Meteo, but fixed in two ways vs. the old collector:
//
//   1. BATCHED. The old code made one HTTP call per grid point (≈420 calls with
//      sleeps every sweep) — slow and the likely cause of the 429s and the
//      "0 grid points (420 errors)" cycles. Open-Meteo accepts comma-separated
//      latitude/longitude lists and returns an array, so the whole grid is a few
//      requests instead of hundreds.
//
//   2. FORECAST PERSISTED. Each sweep we keep not just the current hour but the
//      model's forecast for the next FORECAST_HORIZON_HOURS. Later, when those
//      hours actually arrive, the analysis compares what happened against what
//      was predicted hours earlier — a genuine counterfactual ("more cloud/precip
//      than forecast"), instead of the old "forecast said dry but it rained"
//      which mostly detects forecast error.
//
// This is the synoptic BASELINE only. Fine-scale "what actually happened" is the
// job of the observation adapter (sources/observations.js): radar/satellite.

const { CONUS, WEATHER_GRID_STEP, FORECAST_HORIZON_HOURS, SOURCES } = require("../config");

const HOURLY_VARS = [
  "temperature_2m", "relative_humidity_2m", "precipitation",
  "precipitation_probability", "cloud_cover", "cloud_cover_low",
  "cloud_cover_mid", "cloud_cover_high", "wind_speed_10m",
  "wind_direction_10m", "pressure_msl", "dewpoint_2m", "visibility",
  "freezing_level_height",
];

function gridPoints() {
  const pts = [];
  for (let lat = CONUS.latMin; lat <= CONUS.latMax; lat += WEATHER_GRID_STEP) {
    for (let lng = CONUS.lngMin; lng <= CONUS.lngMax; lng += WEATHER_GRID_STEP) {
      pts.push({ lat, lng });
    }
  }
  return pts;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchBatch(points) {
  const lats = points.map((p) => p.lat).join(",");
  const lngs = points.map((p) => p.lng).join(",");
  const url =
    `${SOURCES.openMeteoUrl}?latitude=${lats}&longitude=${lngs}` +
    `&hourly=${HOURLY_VARS.join(",")}` +
    `&past_hours=1&forecast_hours=${Math.max(1, FORECAST_HORIZON_HOURS)}` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=UTC&cell_selection=nearest`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  let json;
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    json = await res.json();
  } finally {
    clearTimeout(t);
  }
  // Open-Meteo returns an array when multiple coords are requested, or a single
  // object for one coord. Normalize to an array aligned with `points`.
  const arr = Array.isArray(json) ? json : [json];
  return arr.map((entry, i) => ({ point: points[i], hourly: entry.hourly }));
}

function rowsFromHourly(point, hourly, issuedAtISO) {
  // Returns { current, forecasts[] } where current is the row nearest "now" and
  // forecasts are the forward hours (target_hour, issued_at).
  const times = hourly?.time || [];
  const pick = (name, idx) => {
    const a = hourly?.[name];
    return a && a[idx] != null ? a[idx] : null;
  };
  const now = Date.now();
  let nowIdx = 0, best = Infinity;
  for (let i = 0; i < times.length; i++) {
    const diff = Math.abs(new Date(times[i] + "Z").getTime() - now);
    if (diff < best) { best = diff; nowIdx = i; }
  }
  const hourKey = (iso) => iso.slice(0, 13) + ":00:00"; // canonical, no Z

  const mk = (idx) => ({
    grid_lat: point.lat,
    grid_lng: point.lng,
    timestamp: hourKey(times[idx]),
    temperature: pick("temperature_2m", idx),
    humidity: pick("relative_humidity_2m", idx),
    wind_speed: pick("wind_speed_10m", idx),
    wind_dir: pick("wind_direction_10m", idx),
    precip_rate: pick("precipitation", idx),
    precip_prob: pick("precipitation_probability", idx),
    cloud_cover: pick("cloud_cover", idx),
    cloud_cover_low: pick("cloud_cover_low", idx),
    cloud_cover_mid: pick("cloud_cover_mid", idx),
    cloud_cover_high: pick("cloud_cover_high", idx),
    pressure: pick("pressure_msl", idx),
    dewpoint: pick("dewpoint_2m", idx),
    visibility: pick("visibility", idx),
    freezing_level_m: pick("freezing_level_height", idx),
  });

  const current = mk(nowIdx);
  const forecasts = [];
  for (let i = nowIdx + 1; i < times.length; i++) {
    const r = mk(i);
    forecasts.push({
      grid_lat: point.lat,
      grid_lng: point.lng,
      target_hour: r.timestamp,
      issued_at: issuedAtISO,
      cloud_cover: r.cloud_cover,
      precip_rate: r.precip_rate,
      precip_prob: r.precip_prob,
    });
  }
  return { current, forecasts };
}

/**
 * Sweep the whole grid. Returns { current: [...gridRows], forecasts: [...] }.
 * Batches the grid into chunks (Open-Meteo limits coords per request).
 */
async function fetchWeatherGrid(issuedAtISO, { batchSize = 100 } = {}) {
  const pts = gridPoints();
  const current = [];
  const forecasts = [];
  let ok = 0, err = 0;

  for (let i = 0; i < pts.length; i += batchSize) {
    const chunk = pts.slice(i, i + batchSize);
    try {
      const results = await fetchBatch(chunk);
      for (const r of results) {
        if (!r.hourly?.time) { err++; continue; }
        const { current: cur, forecasts: fc } = rowsFromHourly(r.point, r.hourly, issuedAtISO);
        current.push(cur);
        for (const f of fc) forecasts.push(f);
        ok++;
      }
    } catch (e) {
      err += chunk.length;
    }
    await sleep(300); // gentle pacing between batches
  }

  return { current, forecasts, gridOk: ok, gridErr: err, totalPoints: pts.length };
}

module.exports = { fetchWeatherGrid, gridPoints, HOURLY_VARS };
