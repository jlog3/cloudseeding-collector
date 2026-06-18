// ─── AGGREGATE ANALYSIS (THE "REPEAT OFFENDER" TEST) ────────────────────────
// Single events can't prove seeding. The real signal is an airframe that shows
// up upwind-before-anomalies far MORE OFTEN than its flight volume would predict.
//
// Method:
//   • Population: strong wind-coupled candidates (anomaly_candidates.score ≥
//     STRONG) for SEEDABLE anomalies (weather_anomalies.seedable_frac ≥ SEEDABLE)
//     over a lookback window.
//   • Observed kᵢ = # of distinct seedable anomalies airframe i was a strong
//     candidate for.
//   • Null: condition on the candidate population and on how much each airframe
//     flies (exposure ≈ active seeding-band hours). For each anomaly we redraw
//     its d strong-candidate slots from the airframe pool weighted by exposure,
//     P times, and build a null distribution of kᵢ. This controls for "it shows
//     up a lot simply because it flies a lot."
//   • Significance: empirical upper-tail p, then Benjamini–Hochberg FDR across
//     airframes. Flagged airframes are those with more associations than flight
//     volume explains — the candidates worth a human look.
//
// Honest limits: low power until many anomalies accumulate; the pool is the set
// of aircraft that appear near anomalies at all, so this asks "among aircraft
// that turn up near anomalies, which do so beyond their flight volume?" — a
// deliberately conservative framing. It surfaces candidates, not conclusions:
// research/atmospheric-sampling/survey aircraft can rank high and need ruling out.

const cfg = require("./config");

const WINDOW_DAYS = Number(process.env.AGGREGATE_WINDOW_DAYS || 90);
const STRONG = Number(process.env.AGGREGATE_STRONG_SCORE || 55);
const SEEDABLE = Number(process.env.AGGREGATE_SEEDABLE_FRAC || 0.4);
const A = cfg.ANALYSIS;

// Standard normal CDF (Abramowitz & Stegun 7.1.26) — only for a reported z.
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) p = 1 - p;
  return p;
}

// Weighted sampler via cumulative weights + binary search.
function makeSampler(weights) {
  const cum = new Array(weights.length);
  let s = 0;
  for (let i = 0; i < weights.length; i++) { s += weights[i]; cum[i] = s; }
  const total = s;
  return () => {
    const r = Math.random() * total;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < r) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
}

function benjaminiHochberg(items, alpha) {
  // items: [{p, ...}] → adds q (BH-adjusted) and significant flag.
  const m = items.length;
  const order = items.map((it, i) => ({ i, p: it.p })).sort((a, b) => a.p - b.p);
  const q = new Array(m);
  let prev = 1;
  for (let rank = m; rank >= 1; rank--) {
    const { i, p } = order[rank - 1];
    const val = Math.min(prev, (p * m) / rank);
    q[i] = val;
    prev = val;
  }
  // significance threshold: largest rank with p <= (rank/m)*alpha
  let thresh = 0;
  for (let rank = 1; rank <= m; rank++) {
    if (order[rank - 1].p <= (rank / m) * alpha) thresh = order[rank - 1].p;
  }
  items.forEach((it, i) => { it.q = q[i]; it.significant = it.p <= thresh ? 1 : 0; });
  return items;
}

function runAggregate(db, { permutations = A.aggregatePermutations } = {}) {
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString().slice(0, 19);

  // Seedable anomalies in window.
  const anomalies = db
    .prepare(
      `SELECT id FROM weather_anomalies
       WHERE hour >= ? AND seedable_frac >= ?`
    )
    .all(cutoff, SEEDABLE);
  if (anomalies.length === 0) {
    return { airframes: 0, anomalies: 0, note: "no seedable anomalies in window yet" };
  }
  const anomalyIds = new Set(anomalies.map((a) => a.id));

  // Strong candidate edges for those anomalies.
  const edges = db
    .prepare(
      `SELECT anomaly_id, icao24, callsign, operator, aircraft_type,
              is_known_seeder, score
       FROM anomaly_candidates
       WHERE hour >= ? AND score >= ?`
    )
    .all(cutoff, STRONG)
    .filter((e) => anomalyIds.has(e.anomaly_id));

  if (edges.length === 0) {
    return { airframes: 0, anomalies: anomalies.length, note: "no strong candidates in window yet" };
  }

  // Per-airframe aggregation (keyed by icao24, else callsign).
  const air = new Map(); // key -> {icao24, callsign, operator, type, seeder, anomalies:Set, scores:[]}
  const keyOf = (e) => e.icao24 || e.callsign;
  for (const e of edges) {
    const k = keyOf(e);
    if (!k) continue;
    if (!air.has(k)) {
      air.set(k, {
        key: k,
        icao24: e.icao24 || "",
        callsign: e.callsign || "",
        operator: e.operator || "",
        type: e.aircraft_type || "",
        seeder: e.is_known_seeder ? 1 : 0,
        anomalies: new Set(),
        scores: [],
      });
    }
    const a = air.get(k);
    a.anomalies.add(e.anomaly_id);
    a.scores.push(e.score);
    if (e.operator && !a.operator) a.operator = e.operator;
    if (e.aircraft_type && !a.type) a.type = e.aircraft_type;
    if (e.is_known_seeder) a.seeder = 1;
  }

  const keys = [...air.keys()];
  const idx = new Map(keys.map((k, i) => [k, i]));
  const observed = keys.map((k) => air.get(k).anomalies.size);

  // Exposure weight per airframe ≈ distinct active seeding-band hours in window.
  // Fall back to candidacy count (its number of associations) where flight hours
  // aren't available (e.g. callsign-only identities).
  const expoStmt = db.prepare(
    `SELECT COUNT(DISTINCT hour) n FROM flight_hourly_detail
     WHERE icao24 = ? AND hour >= ? AND avg_alt_ft BETWEEN ? AND ?`
  );
  const weights = keys.map((k) => {
    const a = air.get(k);
    let w = 0;
    if (a.icao24) {
      try { w = expoStmt.get(a.icao24, cutoff, cfg.SEED_ALT_MIN, cfg.SEED_ALT_MAX).n; } catch { w = 0; }
    }
    return Math.max(1, w, a.anomalies.size); // never zero; at least its own activity
  });

  // Per-anomaly degree (number of distinct strong-candidate airframes).
  const degByAnomaly = new Map();
  {
    const seen = new Map(); // anomalyId -> Set(airframeKey)
    for (const e of edges) {
      const k = keyOf(e);
      if (!k) continue;
      if (!seen.has(e.anomaly_id)) seen.set(e.anomaly_id, new Set());
      seen.get(e.anomaly_id).add(k);
    }
    for (const [aid, set] of seen) degByAnomaly.set(aid, set.size);
  }
  const degrees = [...degByAnomaly.values()];

  // ── Permutation null ──
  const P = Math.max(50, permutations);
  const sum = new Float64Array(keys.length);
  const sumsq = new Float64Array(keys.length);
  const geCount = new Int32Array(keys.length); // # perms with null >= observed
  const sample = makeSampler(weights);

  const nullCount = new Int32Array(keys.length);
  for (let p = 0; p < P; p++) {
    nullCount.fill(0);
    for (const d of degrees) {
      // draw d distinct airframes weighted by exposure (resample dupes)
      const picked = new Set();
      let guard = 0;
      while (picked.size < d && guard < d * 8) {
        picked.add(sample());
        guard++;
      }
      for (const i of picked) nullCount[i] += 1;
    }
    for (let i = 0; i < keys.length; i++) {
      const v = nullCount[i];
      sum[i] += v;
      sumsq[i] += v * v;
      if (v >= observed[i]) geCount[i] += 1;
    }
  }

  // Build results for airframes meeting the minimum-associations bar.
  const results = [];
  for (let i = 0; i < keys.length; i++) {
    if (observed[i] < A.aggregateMinAssociations) continue;
    const mean = sum[i] / P;
    const variance = Math.max(1e-9, sumsq[i] / P - mean * mean);
    const sd = Math.sqrt(variance);
    const z = (observed[i] - mean) / sd;
    const pEmp = (geCount[i] + 1) / (P + 1); // upper-tail empirical p (add-one smoothed)
    const a = air.get(keys[i]);
    results.push({
      icao24: a.icao24,
      callsign: a.callsign,
      operator: a.operator,
      aircraft_type: a.type,
      is_known_seeder: a.seeder,
      associations: observed[i],
      expected: +mean.toFixed(3),
      excess: +(observed[i] - mean).toFixed(3),
      z: +z.toFixed(3),
      p: pEmp,
      active_hours: weights[i],
      mean_candidate_score: +(a.scores.reduce((s, v) => s + v, 0) / a.scores.length).toFixed(1),
    });
  }

  if (results.length === 0) {
    return { airframes: 0, anomalies: anomalies.length, note: "no airframe met minimum associations" };
  }

  benjaminiHochberg(results, A.aggregateFdrAlpha);

  // Persist.
  const up = db.prepare(
    `INSERT INTO airframe_scores
       (icao24, callsign, operator, aircraft_type, is_known_seeder, associations,
        expected, excess, z, p_value, fdr_q, significant, active_hours,
        mean_candidate_score, updated_at)
     VALUES (@icao24,@callsign,@operator,@aircraft_type,@is_known_seeder,@associations,
        @expected,@excess,@z,@p,@q,@significant,@active_hours,@mean_candidate_score,@updated_at)
     ON CONFLICT(icao24) DO UPDATE SET
        callsign=excluded.callsign, operator=excluded.operator,
        aircraft_type=excluded.aircraft_type, is_known_seeder=excluded.is_known_seeder,
        associations=excluded.associations, expected=excluded.expected,
        excess=excluded.excess, z=excluded.z, p_value=excluded.p_value,
        fdr_q=excluded.fdr_q, significant=excluded.significant,
        active_hours=excluded.active_hours,
        mean_candidate_score=excluded.mean_candidate_score, updated_at=excluded.updated_at`
  );
  const updatedAt = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const r of results) {
      // airframe_scores PK is icao24; skip callsign-only identities to avoid
      // empty-PK collisions (they remain visible via anomaly_candidates).
      if (!r.icao24) continue;
      up.run({ ...r, updated_at: updatedAt });
    }
  });
  tx();

  const flagged = results.filter((r) => r.significant && r.icao24).length;
  return {
    airframes: results.filter((r) => r.icao24).length,
    anomalies: anomalies.length,
    edges: edges.length,
    permutations: P,
    flagged,
    note: `${flagged} airframe(s) above flight-volume expectation at FDR ${A.aggregateFdrAlpha}`,
  };
}

module.exports = { runAggregate, benjaminiHochberg, normCdf };
