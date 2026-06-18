#!/usr/bin/env node
// ─── COMBINED STARTER ───────────────────────────────────────────────────────
// Runs the collector loop AND the API server in one Railway service (Railway
// can't share a volume between services).  node start.js

const { fork } = require("child_process");
const path = require("path");

console.log("CloudSeeding Collector + API Server (v2)");
console.log("=======================================\n");

// Ensure schema exists / is migrated (idempotent).
try { require("./setup-db.js"); } catch (e) { /* setup-db exits cleanly */ }

const api = fork(path.join(__dirname, "serve.js"), { env: { ...process.env }, silent: false });
api.on("error", (err) => console.error("API error:", err.message));
api.on("exit", (code) => { console.error(`API server exited with code ${code}, restarting service...`); process.exit(1); });

const collector = fork(path.join(__dirname, "collect-loop.js"), { env: { ...process.env }, silent: false });
collector.on("error", (err) => console.error("Collector error:", err.message));
collector.on("exit", (code) => { console.error(`Collector exited with code ${code}, restarting service...`); process.exit(1); });

function shutdown() {
  console.log("\nShutting down...");
  api.kill("SIGTERM");
  collector.kill("SIGTERM");
  setTimeout(() => process.exit(0), 2000);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("Both processes running. Ctrl+C to stop.\n");
