#!/usr/bin/env node
// ─── LOOP COLLECTOR ─────────────────────────────────────────────────────────
// Runs collect.js on a repeating interval as a child process.
// Each cycle runs in a fresh process to avoid memory/state leaks.
//
// Usage: node collect-loop.js
//        nohup node collect-loop.js >> collector.log 2>&1 &
//        pm2 start collect-loop.js --name cloudseeding-collector

const { fork } = require("child_process");
const path = require("path");

const INTERVAL_MS = parseInt(process.env.COLLECT_INTERVAL_MS || "300000");
const SCRIPT = path.join(__dirname, "collect.js");
const MONITOR = path.join(__dirname, "monitor.js");

// Maintenance runs much less often than collection. On Railway there is no
// system cron, so the weekly VACUUM that crontab.sample assumes never fires —
// we run it here instead. VACUUM returns deleted-row space to the OS (SQLite
// never shrinks the file on its own), and monitor.js logs storage vitals so a
// stalled compaction is caught early. Default: every 24h.
const MAINTENANCE_MS = parseInt(process.env.MAINTENANCE_INTERVAL_MS || String(24 * 60 * 60 * 1000));

console.log(`CloudSeeding CONUS Collector`);
console.log(`Interval: ${INTERVAL_MS / 1000}s | DB: ${process.env.DB_PATH || "./cloudseeding.db"}`);
console.log(`Maintenance (VACUUM + monitor): every ${MAINTENANCE_MS / 3600000}h`);
console.log(`Press Ctrl+C to stop.\n`);

let running = false;
let maintaining = false;

function runCycle() {
  if (running || maintaining) {
    console.log("Previous cycle or maintenance still running, skipping...");
    return;
  }
  running = true;
  const child = fork(SCRIPT, { env: { ...process.env }, silent: false });
  child.on("exit", (code) => {
    running = false;
    if (code !== 0) console.error(`Cycle exited with code ${code}`);
  });
  child.on("error", (err) => {
    running = false;
    console.error("Cycle error:", err.message);
  });
}

function runMaintenance() {
  // Never overlap maintenance with a collection cycle: VACUUM takes a write
  // lock and scratch space, and a collect insert mid-VACUUM would block.
  if (running || maintaining) {
    console.log("Skipping maintenance — a cycle is active.");
    return;
  }
  maintaining = true;
  console.log("Running maintenance: monitor + incremental VACUUM...");
  // monitor.js --vacuum logs storage vitals AND performs the space reclaim, so
  // all DB-size logic lives in one place.
  const vac = fork(MONITOR, ["--vacuum"], { env: { ...process.env }, silent: false });
  vac.on("exit", () => { maintaining = false; });
  vac.on("error", (err) => { maintaining = false; console.error("Maintenance error:", err.message); });
}

runCycle();
setInterval(runCycle, INTERVAL_MS);
setInterval(runMaintenance, MAINTENANCE_MS);

process.on("SIGINT", () => { console.log("\nStopped."); process.exit(0); });
process.on("SIGTERM", () => { console.log("\nStopped."); process.exit(0); });
