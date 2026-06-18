#!/usr/bin/env node
// ─── AGGREGATE RUNNER ───────────────────────────────────────────────────────
// Rebuilds the airframe "repeat offender" ranking. Expensive-ish (permutation
// null), so it runs on the maintenance cadence, not every collection cycle.
//   node run-aggregate.js

const Database = require("better-sqlite3");
const cfg = require("./config");
const { runAggregate } = require("./aggregate");

const db = new Database(cfg.DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

console.log(`[${new Date().toISOString()}] Aggregate analysis starting...`);
try {
  const r = runAggregate(db);
  console.log(`  ${r.note}`);
  if (r.airframes) {
    console.log(`  Scored ${r.airframes} airframe(s) across ${r.anomalies} seedable anomalies ` +
      `(${r.edges} strong candidate edges, ${r.permutations} permutations).`);
    const top = db.prepare(`
      SELECT icao24, callsign, operator, associations, expected, excess, z, fdr_q, significant
      FROM airframe_scores ORDER BY excess DESC LIMIT 10`).all();
    if (top.length) {
      console.log("  Top by excess (associations beyond flight-volume expectation):");
      for (const t of top) {
        console.log(`    ${t.icao24}${t.callsign ? " " + t.callsign : ""} ` +
          `${t.operator || ""} — assoc ${t.associations}, exp ${t.expected}, excess ${t.excess}, ` +
          `z ${t.z}, q ${typeof t.fdr_q === "number" ? t.fdr_q.toFixed(3) : t.fdr_q}` +
          `${t.significant ? "  ★ FDR-significant" : ""}`);
      }
    }
  }
} catch (err) {
  console.error("Aggregate error:", err.message);
  db.close();
  process.exit(1);
}
db.close();
console.log(`[${new Date().toISOString()}] Aggregate done.\n`);
