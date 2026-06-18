#!/usr/bin/env node
// ─── LOOP COLLECTOR ─────────────────────────────────────────────────────────
// Runs collect.js every interval in a fresh process (avoids memory/state leaks).
// On the (much slower) maintenance cadence it runs monitor --vacuum AND the
// aggregate "repeat offender" ranking, since Railway has no system cron.
//
//   node collect-loop.js

const { fork } = require("child_process");
const path = require("path");
const cfg = require("./config");

const INTERVAL_MS = cfg.COLLECT_INTERVAL_MS;
const MAINTENANCE_MS = cfg.MAINTENANCE_INTERVAL_MS;
const SCRIPT = path.join(__dirname, "collect.js");
const MONITOR = path.join(__dirname, "monitor.js");
const AGGREGATE = path.join(__dirname, "run-aggregate.js");

console.log(`CloudSeeding CONUS Collector (v2)`);
console.log(`Interval: ${INTERVAL_MS / 1000}s | DB: ${cfg.DB_PATH}`);
console.log(`Maintenance (VACUUM + monitor + aggregate): every ${MAINTENANCE_MS / 3600000}h`);
console.log(`Press Ctrl+C to stop.\n`);

let running = false;
let maintaining = false;

function runCycle() {
  if (running || maintaining) { console.log("Previous cycle/maintenance still running, skipping..."); return; }
  running = true;
  const child = fork(SCRIPT, { env: { ...process.env }, silent: false });
  child.on("exit", (code) => { running = false; if (code !== 0) console.error(`Cycle exited with code ${code}`); });
  child.on("error", (err) => { running = false; console.error("Cycle error:", err.message); });
}

function runMaintenance() {
  if (running || maintaining) { console.log("Skipping maintenance — a cycle is active."); return; }
  maintaining = true;
  console.log("Running maintenance: monitor + incremental VACUUM...");
  const vac = fork(MONITOR, ["--vacuum"], { env: { ...process.env }, silent: false });
  vac.on("exit", () => {
    // Chain the aggregate run after vacuum completes (both need exclusive-ish DB time).
    console.log("Running maintenance: aggregate ranking...");
    const agg = fork(AGGREGATE, { env: { ...process.env }, silent: false });
    agg.on("exit", () => { maintaining = false; });
    agg.on("error", (err) => { maintaining = false; console.error("Aggregate error:", err.message); });
  });
  vac.on("error", (err) => { maintaining = false; console.error("Maintenance error:", err.message); });
}

runCycle();
setInterval(runCycle, INTERVAL_MS);
setInterval(runMaintenance, MAINTENANCE_MS);

process.on("SIGINT", () => { console.log("\nStopped."); process.exit(0); });
process.on("SIGTERM", () => { console.log("\nStopped."); process.exit(0); });
