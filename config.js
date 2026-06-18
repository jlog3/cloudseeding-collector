// ─── CENTRAL CONFIG ─────────────────────────────────────────────────────────
// Single source of truth for the collector. Everything that used to be a magic
// number scattered across collect.js / serve.js / setup-db.js now lives here so
// the acquisition layer and the analysis layer agree on the same definitions.
//
// Override anything via environment variables (see .env.example).

const path = require("path");

function num(name, def) {
  const v = process.env[name];
  return v === undefined || v === "" ? def : Number(v);
}
function str(name, def) {
  const v = process.env[name];
  return v === undefined || v === "" ? def : v;
}
function bool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return /^(1|true|yes|on)$/i.test(v);
}

// ── Storage ──────────────────────────────────────────────────────────────────
const DB_PATH = str("DB_PATH", path.join(__dirname, "cloudseeding.db"));

// ── Geographic scope (CONUS) ─────────────────────────────────────────────────
const CONUS = {
  latMin: num("CONUS_LAT_MIN", 24),
  latMax: num("CONUS_LAT_MAX", 50),
  lngMin: num("CONUS_LNG_MIN", -125),
  lngMax: num("CONUS_LNG_MAX", -66),
};

// Weather grid spacing in degrees. Coarse grid is only the *baseline* layer;
// fine-scale anomaly structure is meant to come from the observation adapter
// (radar/satellite). 2.5° ≈ 170 mi — fine for a synoptic baseline, and ~264
// CONUS points keeps the once-hourly sweep under Open-Meteo's free 10k/day limit
// (2° = 420 pts = 10,080/day, which exceeds it). Set 3 for more headroom on a
// shared egress IP, or 2 if you have a paid/self-hosted Open-Meteo endpoint.
const WEATHER_GRID_STEP = num("WEATHER_GRID_STEP", 2.5);

// ── Altitude bands (feet) ────────────────────────────────────────────────────
// The *storage* band is wide (keep anything plausibly operational). The
// *operational seeding* band is the narrow one the analysis actually trusts for
// loiter / track scoring; the old 8k–28k band swept in cruise + military orbits.
const STORE_ALT_MIN = num("STORE_ALT_MIN", 2000);   // store low passes up...
const STORE_ALT_MAX = num("STORE_ALT_MAX", 24000);  // ...to ~FL240; above = jet cruise, count only
const SEED_ALT_MIN = num("SEED_ALT_MIN", 5000);     // realistic glaciogenic seeding band
const SEED_ALT_MAX = num("SEED_ALT_MAX", 14000);

// ── Retention / compaction ───────────────────────────────────────────────────
const RAW_RETENTION_HOURS = num("RAW_RETENTION_HOURS", 48); // full-res rolling window
const COLLECT_INTERVAL_MS = num("COLLECT_INTERVAL_MS", 300000);
const MAINTENANCE_INTERVAL_MS = num("MAINTENANCE_INTERVAL_MS", 24 * 60 * 60 * 1000);

// How far ahead we persist the model forecast each sweep. This is what lets us
// build a genuine counterfactual later: "what was predicted N hours ago for the
// hour that just happened?" Anomaly = actual materially exceeds that forecast.
const FORECAST_HORIZON_HOURS = num("FORECAST_HORIZON_HOURS", 12);

// ── Analysis tuning ──────────────────────────────────────────────────────────
const ANALYSIS = {
  // Loiter signature
  loiterMinSightings: num("LOITER_MIN_SIGHTINGS", 6),
  loiterMaxSpreadDeg: num("LOITER_MAX_SPREAD", 0.3),
  loiterMinSpeedKts: num("LOITER_MIN_SPEED", 80),

  // Anomaly thresholds (vs. the earlier forecast baseline)
  cloudExcessVsForecast: num("CLOUD_EXCESS_VS_FORECAST", 25), // % more cloud than forecast
  precipExcessVsForecast: num("PRECIP_EXCESS_VS_FORECAST", 0.2), // mm/h beyond forecast
  // Fallback (no baseline yet): hour-over-hour persistence jump
  cloudJumpFallback: num("CLOUD_JUMP_FALLBACK", 25),

  // Seedability proxy: a cloud must plausibly hold supercooled liquid water.
  // Real input is GOES cloud-top temperature; until that adapter is wired we
  // proxy from surface temp + humidity + cloud presence. See analysis.js.
  seedabilityMinCloud: num("SEEDABILITY_MIN_CLOUD", 40),       // % mid/low cloud
  seedabilityMaxSurfaceTempF: num("SEEDABILITY_MAX_TEMP_F", 55), // colder favors supercooling
  seedabilityMinHumidity: num("SEEDABILITY_MIN_HUMIDITY", 70),

  // Wind-coupled backtracking
  lagHoursMin: num("LAG_HOURS_MIN", 0.5),
  lagHoursMax: num("LAG_HOURS_MAX", 3),
  lagHoursStep: num("LAG_HOURS_STEP", 0.5),
  upwindRadiusKm: num("UPWIND_RADIUS_KM", 40), // search radius around the upwind point
  windPerpToleranceDeg: num("WIND_PERP_TOLERANCE", 35), // seeding legs run ~⊥ to wind

  // Preservation
  preserveThreshold: num("PRESERVE_THRESHOLD", 45),
  contextHoursBefore: num("CONTEXT_HOURS_BEFORE", 2),
  contextHoursAfter: num("CONTEXT_HOURS_AFTER", 1),
  preserveRadiusDeg: num("PRESERVE_RADIUS_DEG", 1.0),

  // Aggregation (the "repeat offender" test)
  aggregatePermutations: num("AGGREGATE_PERMUTATIONS", 500),
  aggregateMinAssociations: num("AGGREGATE_MIN_ASSOC", 3), // ignore airframes seen < this
  aggregateFdrAlpha: num("AGGREGATE_FDR_ALPHA", 0.1),
};

// ── Data sources ─────────────────────────────────────────────────────────────
const SOURCES = {
  // Flights: OpenSky (OAuth2 client-credentials preferred, anonymous fallback),
  // then airplanes.live as a secondary unfiltered feed.
  openskyClientId: str("OPENSKY_CLIENT_ID", ""),
  openskyClientSecret: str("OPENSKY_CLIENT_SECRET", ""),
  openskyTokenUrl: str(
    "OPENSKY_TOKEN_URL",
    "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"
  ),
  openskyStatesUrl: str("OPENSKY_STATES_URL", "https://opensky-network.org/api/states/all"),
  useAirplanesLive: bool("USE_AIRPLANES_LIVE", true),
  airplanesLiveUrl: str("AIRPLANES_LIVE_URL", "https://api.airplanes.live/v2"),

  // Weather baseline: Open-Meteo (batched multi-point).
  openMeteoUrl: str("OPEN_METEO_URL", "https://api.open-meteo.com/v1/forecast"),

  // Observation adapter: which "actual conditions" source the anomaly detector
  // trusts. "openmeteo" = model best-estimate (default, fully runnable).
  // "mrms"/"goes" = real radar/satellite via a Python sidecar (see
  // sources/observations.js — documented, not enabled by default).
  observationSource: str("OBSERVATION_SOURCE", "openmeteo"),
};

module.exports = {
  DB_PATH,
  CONUS,
  WEATHER_GRID_STEP,
  STORE_ALT_MIN,
  STORE_ALT_MAX,
  SEED_ALT_MIN,
  SEED_ALT_MAX,
  RAW_RETENTION_HOURS,
  COLLECT_INTERVAL_MS,
  MAINTENANCE_INTERVAL_MS,
  FORECAST_HORIZON_HOURS,
  ANALYSIS,
  SOURCES,
};
