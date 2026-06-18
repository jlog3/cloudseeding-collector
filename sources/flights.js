// ─── FLIGHT ACQUISITION ─────────────────────────────────────────────────────
// Normalizes flight state from whichever source is available into a single
// shape keyed on icao24:
//   { icao24, callsign, lat, lng, alt_ft, speed_kts, heading, vrate_fpm,
//     squawk, on_ground, source }
//
// Source priority:
//   1. OpenSky with OAuth2 client-credentials (much higher rate limits than the
//      anonymous endpoint — this is the real fix for the 429 / "fetch failed"
//      cycles). Set OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET.
//   2. OpenSky anonymous (works, but tightly throttled).
//   3. airplanes.live (free, UNFILTERED — shows airframes that block themselves
//      from FAA LADD/PIA feeds, which is exactly the population of interest).
//      CONUS is covered by tiling 250-nm point queries.

const fs = require("fs");
const path = require("path");
const { CONUS, SOURCES, DB_PATH } = require("../config");

const TOKEN_CACHE = path.join(path.dirname(DB_PATH), ".opensky_token.json");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchWithTimeout(url, opts = {}, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ── OpenSky OAuth2 token (cached to a file so it survives the per-cycle fork) ──
async function getOpenskyToken() {
  if (!SOURCES.openskyClientId || !SOURCES.openskyClientSecret) return null;

  try {
    const cached = JSON.parse(fs.readFileSync(TOKEN_CACHE, "utf8"));
    if (cached.access_token && cached.expires_at > Date.now() + 30000) {
      return cached.access_token;
    }
  } catch { /* no/invalid cache */ }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: SOURCES.openskyClientId,
    client_secret: SOURCES.openskyClientSecret,
  });
  const res = await fetchWithTimeout(SOURCES.openskyTokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`OpenSky token ${res.status}`);
  const json = await res.json();
  const token = json.access_token;
  const ttl = (json.expires_in || 1800) * 1000;
  try {
    fs.writeFileSync(
      TOKEN_CACHE,
      JSON.stringify({ access_token: token, expires_at: Date.now() + ttl })
    );
  } catch { /* best-effort cache */ }
  return token;
}

function normOpenSky(states) {
  const out = [];
  for (const sv of states || []) {
    const lat = sv[6], lng = sv[5];
    if (lat == null || lng == null) continue;
    const altM = sv[13] ?? sv[7];
    out.push({
      icao24: (sv[0] || "").toLowerCase(),
      callsign: (sv[1] || "").trim().toUpperCase(),
      lat,
      lng,
      alt_ft: altM == null ? null : Math.round(altM * 3.28084),
      speed_kts: sv[9] == null ? null : Math.round(sv[9] * 1.94384),
      heading: sv[10] == null ? null : Math.round(sv[10]),
      vrate_fpm: sv[11] == null ? null : Math.round(sv[11] * 196.85),
      squawk: sv[14] || "",
      on_ground: sv[8] ? 1 : 0,
      source: "opensky",
    });
  }
  return out;
}

async function fetchOpenSky() {
  const url =
    `${SOURCES.openskyStatesUrl}` +
    `?lamin=${CONUS.latMin}&lamax=${CONUS.latMax}` +
    `&lomin=${CONUS.lngMin}&lomax=${CONUS.lngMax}`;

  let token = null;
  try { token = await getOpenskyToken(); } catch (e) { /* fall through to anon */ }

  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  // One retry with backoff on 429/5xx.
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetchWithTimeout(url, { headers });
    if (res.ok) {
      const json = await res.json();
      return { states: normOpenSky(json.states), authed: !!token };
    }
    if (res.status === 429 || res.status >= 500) {
      const wait = 2000 * (attempt + 1);
      await sleep(wait);
      continue;
    }
    throw new Error(`OpenSky ${res.status}`);
  }
  throw new Error("OpenSky rate-limited after retry");
}

// ── airplanes.live (tiled point queries to cover CONUS) ───────────────────────
function conusTiles(radiusNm = 250) {
  // Convert radius (nm) to degrees of latitude; step tiles a bit tighter than
  // the diameter to avoid gaps at the corners.
  const dLat = (radiusNm / 60) * 1.6; // ~ tile step in latitude degrees
  const tiles = [];
  for (let lat = CONUS.latMin; lat <= CONUS.latMax + dLat; lat += dLat) {
    // longitude degrees shrink with latitude
    const dLng = dLat / Math.max(0.3, Math.cos((lat * Math.PI) / 180));
    for (let lng = CONUS.lngMin; lng <= CONUS.lngMax + dLng; lng += dLng) {
      tiles.push({ lat: Math.min(lat, CONUS.latMax), lng: Math.min(lng, CONUS.lngMax) });
    }
  }
  return tiles;
}

function normAirplanesLive(ac) {
  const out = [];
  for (const a of ac || []) {
    if (a.lat == null || a.lon == null) continue;
    const ground = a.alt_baro === "ground";
    const altFt = ground ? 0 : (typeof a.alt_baro === "number" ? a.alt_baro : (a.alt_geom ?? null));
    out.push({
      icao24: (a.hex || "").toLowerCase(),
      callsign: (a.flight || "").trim().toUpperCase(),
      lat: a.lat,
      lng: a.lon,
      alt_ft: altFt == null ? null : Math.round(altFt),
      speed_kts: a.gs == null ? null : Math.round(a.gs),
      heading: a.track == null ? null : Math.round(a.track),
      vrate_fpm: a.baro_rate == null ? null : Math.round(a.baro_rate),
      squawk: a.squawk || "",
      on_ground: ground ? 1 : 0,
      source: "airplanes.live",
    });
  }
  return out;
}

async function fetchAirplanesLive() {
  const tiles = conusTiles(250);
  const seen = new Map(); // icao24 -> record (dedupe across overlapping tiles)
  let ok = 0, err = 0;
  for (const t of tiles) {
    try {
      const url = `${SOURCES.airplanesLiveUrl}/point/${t.lat.toFixed(3)}/${t.lng.toFixed(3)}/250`;
      const res = await fetchWithTimeout(url, {
        headers: { "User-Agent": "cloudseeding-collector/2.0 (transparency research)" },
      }, 15000);
      if (!res.ok) { err++; await sleep(250); continue; }
      const json = await res.json();
      for (const rec of normAirplanesLive(json.ac)) {
        if (rec.icao24 && !seen.has(rec.icao24)) seen.set(rec.icao24, rec);
      }
      ok++;
    } catch { err++; }
    await sleep(250); // be polite to the free endpoint
  }
  if (ok === 0) throw new Error("airplanes.live: all tiles failed");
  return { states: [...seen.values()], tilesOk: ok, tilesErr: err };
}

/**
 * Fetch a CONUS-wide flight snapshot, trying sources in priority order.
 * Returns { states, meta } where meta describes which source(s) were used.
 */
async function fetchFlights() {
  const meta = { source: null, authed: false, notes: [] };
  // 1 + 2: OpenSky (authed, then anon retry is handled inside)
  try {
    const r = await fetchOpenSky();
    meta.source = "opensky";
    meta.authed = r.authed;
    if (!r.authed) meta.notes.push("OpenSky anonymous (set OPENSKY_CLIENT_ID/SECRET to raise limits)");
    if (r.states.length > 0) return { states: r.states, meta };
    meta.notes.push("OpenSky returned 0 states; trying fallback");
  } catch (e) {
    meta.notes.push(`OpenSky failed: ${e.message}`);
  }

  // 3: airplanes.live fallback
  if (SOURCES.useAirplanesLive) {
    try {
      const r = await fetchAirplanesLive();
      meta.source = "airplanes.live";
      meta.notes.push(`airplanes.live tiles ok=${r.tilesOk} err=${r.tilesErr}`);
      return { states: r.states, meta };
    } catch (e) {
      meta.notes.push(`airplanes.live failed: ${e.message}`);
    }
  }

  throw new Error("All flight sources failed: " + meta.notes.join(" | "));
}

module.exports = { fetchFlights, nNumberHelpers: {}, _internals: { conusTiles, normOpenSky, normAirplanesLive } };
