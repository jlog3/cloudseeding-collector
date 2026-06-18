// ─── SEEDER REGISTRY ────────────────────────────────────────────────────────
// Identity is keyed on icao24 (the 24-bit ICAO hex address), which is stable per
// airframe — NOT on callsign/registration, which the old detector matched on and
// which can change or be spoofed.
//
// The registry is built from three layers, merged at load time:
//   1. seeder_registry table  — the authoritative list, populated by
//      fetch-faa-seeders.js from the FAA Releasable Aircraft Database
//      (which publishes the Mode S / ICAO hex directly) filtered to known
//      weather-modification operators.
//   2. data/operators.json    — operator NAME PATTERNS (real, public companies)
//      used by the FAA importer, plus any manual icao24/registration entries you
//      want to pin (e.g. tail numbers named in NOAA weather-mod reports).
//   3. A tiny built-in fallback so the matcher is never empty on a fresh DB.
//
// Why NOAA + FAA: US law (15 U.S.C. §330) requires anyone conducting weather
// modification to report it; those reports name operators. The FAA registry then
// maps an operator's fleet to specific airframes + their ICAO hex. Run
// fetch-faa-seeders.js to turn "operator names" into "icao24 set".

const fs = require("fs");
const path = require("path");

// 24-letter set used in US registration marks (no I, no O).
const SUFFIX = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "0123456789";

// Bucket sizes for the FAA N-number → ICAO algorithm. Derived from the grammar
// "first digit 1-9, then digits, then at most two letters, total ≤5 chars".
// cnt(4,0)=101711 (per leading digit), cnt(3,0)=10111, cnt(2,0)=951, cnt(1,0)=35.
// Sanity: 9 * 101711 = 915399 = (0xADF7C7 - 0xA00001) + 1, the exact US block.
const US_ICAO_BASE = 0xa00001;

function suffixOffset(suf) {
  if (!suf || suf.length === 0) return 0;
  const i0 = SUFFIX.indexOf(suf[0]);
  if (i0 < 0) return -1;
  if (suf.length === 1) return i0 + 1;
  const i1 = SUFFIX.indexOf(suf[1]);
  if (i1 < 0) return -1;
  return i0 * 24 + i1 + 25;
}

/**
 * Convert a US N-number (e.g. "N350WM") to its ICAO 24-bit hex (lowercase, e.g.
 * "a3f1c2"). Returns null for non-US or malformed marks. This is only needed to
 * pin airframes specified by tail number; the FAA importer reads the hex
 * directly and does not rely on this.
 */
function nNumberToIcao24(nNumber) {
  if (!nNumber) return null;
  const t = String(nNumber).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (t[0] !== "N") return null;
  const s = t.slice(1);
  if (s.length < 1 || s.length > 5) return null;
  if (!/[1-9]/.test(s[0])) return null;

  let icao = US_ICAO_BASE + (s.charCodeAt(0) - 49) * 101711; // '1' -> 0
  // Digit bucket size by position k (1..4) = remaining-positions cnt(r,0).
  const digitBucket = [null, 10111, 951, 35, 1];
  // First-letter bucket size by position k (1..4) = cnt(r,1).
  const letter1Bucket = [null, 25, 25, 25, 1];

  let m = 0; // letters used so far
  for (let k = 1; k < s.length; k++) {
    const c = s[k];
    if (m === 0 && DIGITS.includes(c)) {
      icao += 1 + (c.charCodeAt(0) - 48) * digitBucket[k];
    } else if (m === 0) {
      // first letter: skip prefix-terminal(1) + all 10 digit children, then siblings
      const j = SUFFIX.indexOf(c);
      if (j < 0) return null;
      icao += 1 + 10 * digitBucket[k] + j * letter1Bucket[k];
      m = 1;
    } else if (m === 1) {
      // second letter: each sibling consumes 1
      const j = SUFFIX.indexOf(c);
      if (j < 0) return null;
      icao += 1 + j;
      m = 2;
    } else {
      return null; // can't have more than 2 letters
    }
  }
  return icao.toString(16).padStart(6, "0");
}

function normHex(h) {
  if (!h) return null;
  const s = String(h).trim().toLowerCase().replace(/[^0-9a-f]/g, "");
  return s.length === 6 ? s : (s.length ? s.padStart(6, "0") : null);
}

// ── Built-in fallback ─────────────────────────────────────────────────────────
// Operator NAME PATTERNS are real, public weather-modification companies/agencies
// and are safe to ship as search terms for the FAA importer. We do NOT ship
// specific tail numbers as fact — those are resolved from the live FAA registry
// by fetch-faa-seeders.js (or pinned by you in data/operators.json).
const BUILTIN_OPERATOR_PATTERNS = [
  "WEATHER MODIFICATION",            // Weather Modification International (WMI)
  "NORTH AMERICAN WEATHER",          // North American Weather Consultants (NAWC)
  "WESTERN WEATHER",                 // Western Weather Consultants
  "ICE CRYSTAL ENGINEERING",
  "SOAR ",                           // SOAR / Seeding Operations & Atmospheric Research
  "RHS CONSULTING",
  "DESERT RESEARCH INSTITUTE",       // DRI (NV state programs)
  "WEATHER MOD",
  "CLOUD SEED",
  "RAINMAKER",
];

function loadOperatorsFile() {
  const p = path.join(__dirname, "data", "operators.json");
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return {
      patterns: Array.isArray(j.operatorPatterns) ? j.operatorPatterns : [],
      pins: Array.isArray(j.pinnedAircraft) ? j.pinnedAircraft : [],
    };
  } catch {
    return { patterns: [], pins: [] };
  }
}

/**
 * Build the in-memory registry. Returns:
 *   byIcao   Map<icao24, {operator, type, source}>
 *   patterns string[]  (operator name patterns, for the FAA importer)
 *   size     number
 */
function loadSeederRegistry(db) {
  const byIcao = new Map();

  // Layer 3: built-in patterns
  const patterns = new Set(BUILTIN_OPERATOR_PATTERNS.map((s) => s.toUpperCase()));

  // Layer 2: operators.json (patterns + manual pins by icao24 or N-number)
  const ops = loadOperatorsFile();
  for (const p of ops.patterns) patterns.add(String(p).toUpperCase());
  for (const pin of ops.pins) {
    const hex = normHex(pin.icao24) || nNumberToIcao24(pin.registration || pin.nNumber);
    if (hex) {
      byIcao.set(hex, {
        operator: pin.operator || "Pinned operator",
        type: pin.type || pin.aircraft_type || "",
        registration: (pin.registration || pin.nNumber || "").toUpperCase(),
        source: "pin",
      });
    }
  }

  // Layer 1: the FAA-derived table (authoritative)
  if (db) {
    try {
      const rows = db
        .prepare(
          "SELECT icao24, operator, aircraft_type, registration FROM seeder_registry"
        )
        .all();
      for (const r of rows) {
        const hex = normHex(r.icao24);
        if (!hex) continue;
        byIcao.set(hex, {
          operator: r.operator || "",
          type: r.aircraft_type || "",
          registration: (r.registration || "").toUpperCase(),
          source: "faa",
        });
      }
    } catch {
      // table may not exist on a brand-new DB; that's fine
    }
  }

  return { byIcao, patterns: [...patterns], size: byIcao.size };
}

/**
 * Classify a live aircraft. Primary match is icao24. We deliberately do NOT
 * match on callsign/registration text alone (spoofable, and a registration in
 * the callsign field is not authoritative), but a registry hit carries the
 * operator's known registration through for display.
 */
function classify(icao24, callsign, registry) {
  const hex = normHex(icao24);
  if (hex && registry.byIcao.has(hex)) {
    const info = registry.byIcao.get(hex);
    return {
      isKnownSeeder: true,
      operator: info.operator || "Known weather-mod operator",
      type: info.type || "",
      matchedBy: "icao24",
    };
  }
  return { isKnownSeeder: false, operator: "", type: "", matchedBy: null };
}

module.exports = {
  nNumberToIcao24,
  normHex,
  loadSeederRegistry,
  classify,
  BUILTIN_OPERATOR_PATTERNS,
};
