// ─── OBSERVATION ADAPTER ────────────────────────────────────────────────────
// The analysis layer asks ONE question: "what were the actual conditions in this
// hour?" and never cares where the answer comes from. That indirection is here
// so the truth source can be upgraded from model data to real radar/satellite
// without changing a line of analysis.js.
//
// Normalized cell shape returned to the analysis:
//   { lat, lng, cloud_cover, cloud_top_temp_c|null, precip_rate, precip_prob,
//     temperature, humidity, dewpoint, freezing_level_m, wind_speed, wind_dir,
//     seedable_hint|null }
//
// Sources (OBSERVATION_SOURCE):
//   • "openmeteo" (default, fully runnable): the weather_grid rows the collector
//      already stores. This is MODEL best-estimate, not observation — honest
//      label. cloud_top_temp_c is null (Open-Meteo doesn't provide it).
//   • "mrms" / "goes": real observations via a small Python sidecar that parses
//      the NOAA products (MRMS QPE GRIB2 for precip, GOES-16/18 ABI NetCDF for
//      cloud-top temperature). Those formats need the scientific Python stack
//      (xarray/cfgrib/pyart), which does not belong in this Node service — so the
//      sidecar exposes them over HTTP at OBSERVATION_SIDECAR_URL and returns the
//      same normalized cells. If the sidecar is unreachable we fall back to the
//      model grid and flag it, so the pipeline never goes dark.
//
// Wiring real observations later is then a config flip + standing up the sidecar;
// the scoring, coupling and aggregation all keep working unchanged.

const { SOURCES, CONUS } = require("../config");

function cellFromGridRow(r) {
  return {
    lat: r.grid_lat,
    lng: r.grid_lng,
    cloud_cover: r.cloud_cover,
    cloud_cover_low: r.cloud_cover_low,
    cloud_cover_mid: r.cloud_cover_mid,
    cloud_cover_high: r.cloud_cover_high,
    cloud_top_temp_c: null, // not available from the model source
    precip_rate: r.precip_rate,
    precip_prob: r.precip_prob,
    temperature: r.temperature,
    humidity: r.humidity,
    dewpoint: r.dewpoint,
    freezing_level_m: r.freezing_level_m ?? null,
    wind_speed: r.wind_speed,
    wind_dir: r.wind_dir,
    seedable_hint: null,
  };
}

function fromWeatherGrid(db, hour) {
  const rows = db
    .prepare(
      `SELECT grid_lat, grid_lng, cloud_cover, cloud_cover_low, cloud_cover_mid,
              cloud_cover_high, precip_rate, precip_prob, temperature, humidity,
              dewpoint, wind_speed, wind_dir,
              ${columnExists(db, "weather_grid", "freezing_level_m") ? "freezing_level_m" : "NULL AS freezing_level_m"}
       FROM weather_grid WHERE timestamp = ?`
    )
    .all(hour);
  return rows.map(cellFromGridRow);
}

// Tiny schema probe so this module works whether or not the freezing-level
// column has been added yet (older DBs).
const _colCache = new Map();
function columnExists(db, table, col) {
  const key = table + "." + col;
  if (_colCache.has(key)) return _colCache.get(key);
  let has = false;
  try {
    const info = db.prepare(`PRAGMA table_info(${table})`).all();
    has = info.some((c) => c.name === col);
  } catch { has = false; }
  _colCache.set(key, has);
  return has;
}

async function fromSidecar(hour, kind) {
  const base = process.env.OBSERVATION_SIDECAR_URL;
  if (!base) throw new Error("OBSERVATION_SIDECAR_URL not set");
  const url =
    `${base.replace(/\/$/, "")}/observations?hour=${encodeURIComponent(hour)}` +
    `&kind=${kind}&latMin=${CONUS.latMin}&latMax=${CONUS.latMax}` +
    `&lngMin=${CONUS.lngMin}&lngMax=${CONUS.lngMax}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`sidecar ${res.status}`);
    const json = await res.json();
    return Array.isArray(json.cells) ? json.cells : [];
  } finally {
    clearTimeout(t);
  }
}

/**
 * Get observed cells for an hour. Always resolves to *something* usable; on
 * sidecar failure it degrades to the model grid and records why in `meta`.
 */
async function getObservedCells(db, hour) {
  const src = (SOURCES.observationSource || "openmeteo").toLowerCase();
  const meta = { source: src, degraded: false, note: "" };

  if (src === "openmeteo") {
    return { cells: fromWeatherGrid(db, hour), meta };
  }

  // mrms / goes via sidecar, with model fallback
  try {
    const cells = await fromSidecar(hour, src);
    if (cells.length === 0) throw new Error("sidecar returned no cells");
    return { cells, meta };
  } catch (e) {
    meta.degraded = true;
    meta.source = "openmeteo";
    meta.note = `observation source "${src}" unavailable (${e.message}); using model grid`;
    return { cells: fromWeatherGrid(db, hour), meta };
  }
}

module.exports = { getObservedCells, _cellFromGridRow: cellFromGridRow };
