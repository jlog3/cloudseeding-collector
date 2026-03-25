#!/usr/bin/env node
// ─── COMBINED STARTER ───────────────────────────────────────────────────────
// Runs both the collector loop AND the API server in a single Railway service.
// Railway doesn't support shared volumes between services, so we run both here.
//
// Usage: node start.js

const { fork } = require("child_process");
const path = require("path");

console.log("CloudSeeding Collector + API Server");
console.log("====================================\n");

// Ensure DB exists
try {
  require("./setup-db.js");
} catch (e) {
  // setup-db exits cleanly, ignore
}

// Start the API server as a child process
const api = fork(path.join(__dirname, "serve.js"), {
  env: { ...process.env },
  silent: false,
});
api.on("error", (err) => console.error("API error:", err.message));
api.on("exit", (code) => {
  console.error(`API server exited with code ${code}, restarting...`);
  // Could restart here, but Railway will restart the whole service
  process.exit(1);
});

// Start the collector loop as a child process
const collector = fork(path.join(__dirname, "collect-loop.js"), {
  env: { ...process.env },
  silent: false,
});
collector.on("error", (err) => console.error("Collector error:", err.message));
collector.on("exit", (code) => {
  console.error(`Collector exited with code ${code}, restarting...`);
  process.exit(1);
});

// Graceful shutdown
function shutdown() {
  console.log("\nShutting down...");
  api.kill("SIGTERM");
  collector.kill("SIGTERM");
  setTimeout(() => process.exit(0), 2000);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("Both processes running. Ctrl+C to stop.\n");
