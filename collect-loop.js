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

console.log(`CloudSeeding CONUS Collector`);
console.log(`Interval: ${INTERVAL_MS / 1000}s | DB: ${process.env.DB_PATH || "./cloudseeding.db"}`);
console.log(`Press Ctrl+C to stop.\n`);

let running = false;

function runCycle() {
  if (running) {
    console.log("Previous cycle still running, skipping...");
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

runCycle();
setInterval(runCycle, INTERVAL_MS);

process.on("SIGINT", () => { console.log("\nStopped."); process.exit(0); });
process.on("SIGTERM", () => { console.log("\nStopped."); process.exit(0); });
