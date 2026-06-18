#!/usr/bin/env node
// ─── FAA SEEDER REGISTRY IMPORTER ─────────────────────────────────────────────
// Turns "known weather-modification operator names" into a concrete icao24 set.
//
// Source: the FAA Releasable Aircraft Database (public). Its MASTER file lists,
// per registered aircraft, the registered owner NAME and the "MODE S CODE HEX"
// (the ICAO 24-bit address) DIRECTLY — so no N-number→ICAO conversion is needed
// and the mapping is authoritative. We filter MASTER to rows whose owner NAME
// matches a weather-mod operator pattern, join ACFTREF for the aircraft model,
// and write them into the seeder_registry table + data/seeders.json.
//
// Operator patterns come from (merged):
//   • data/operators.json  → operatorPatterns  (edit this; add operators named in
//     NOAA weather-modification reports under 15 U.S.C. §330)
//   • the built-in list in seeders.js
//
// Usage:
//   node fetch-faa-seeders.js                       # download from registry.faa.gov
//   node fetch-faa-seeders.js ./ReleasableAircraft.zip   # use a local copy
//
// Requires (lazy): adm-zip, csv-parse  (in package.json; only this script needs them)

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const cfg = require("./config");
const { BUILTIN_OPERATOR_PATTERNS } = require("./seeders");

const FAA_URL = process.env.FAA_DB_URL || "https://registry.faa.gov/database/ReleasableAircraft.zip";
const localZip = process.argv[2] || null;

function loadPatterns() {
  const set = new Set(BUILTIN_OPERATOR_PATTERNS.map((s) => s.toUpperCase()));
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "operators.json"), "utf8"));
    for (const p of j.operatorPatterns || []) set.add(String(p).toUpperCase());
  } catch {}
  return [...set];
}

async function getZipBuffer() {
  if (localZip) {
    console.log(`Reading local zip: ${localZip}`);
    return fs.readFileSync(localZip);
  }
  console.log(`Downloading FAA database: ${FAA_URL}`);
  console.log("(≈ 100+ MB; if your environment can't reach registry.faa.gov, download it");
  console.log(" manually in a browser and re-run: node fetch-faa-seeders.js ./ReleasableAircraft.zip)");
  const res = await fetch(FAA_URL, { headers: { "User-Agent": "cloudseeding-collector/2.0" } });
  if (!res.ok) throw new Error(`FAA download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`Downloaded ${(buf.length / 1048576).toFixed(1)} MB`);
  return buf;
}

function findEntry(zip, name) {
  const entries = zip.getEntries();
  const hit = entries.find((e) => e.entryName.toUpperCase().endsWith(name.toUpperCase()));
  return hit ? hit.getData().toString("utf8") : null;
}

async function main() {
  let AdmZip, csvParse;
  try {
    AdmZip = require("adm-zip");
    csvParse = require("csv-parse/sync").parse;
  } catch (e) {
    console.error("\nMissing dependency. Install the importer deps:\n  npm install adm-zip csv-parse\n");
    process.exit(1);
  }

  const patterns = loadPatterns();
  // Whole-word matching: "\bSEEDING OPERATIONS\b" matches the real operator but
  // NOT substrings like "AGRISOAR" or unrelated names. (Bare substring matching
  // was why a dozen soaring clubs + a law-marketing firm slipped in.)
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patternRes = patterns.map((p) => new RegExp("\\b" + escape(p) + "\\b", "i"));
  console.log(`Operator patterns (${patterns.length}): ${patterns.join(" | ")}\n`);

  const buf = await getZipBuffer();
  const zip = new AdmZip(buf);

  const masterCsv = findEntry(zip, "MASTER.txt");
  const acftrefCsv = findEntry(zip, "ACFTREF.txt");
  if (!masterCsv) throw new Error("MASTER.txt not found in the FAA zip");

  // The FAA files are comma-separated but NOT RFC-4180 quoted — values like
  // 'JR ACE "' contain literal quotes. relax_quotes treats those as data;
  // skip_records_with_error drops any remaining malformed row instead of
  // aborting the whole import.
  const parseOpts = {
    columns: (h) => h.map((c) => c.trim()),
    relax_column_count: true,
    relax_quotes: true,
    skip_records_with_error: true,
    skip_empty_lines: true,
    trim: true,
  };
  const master = csvParse(masterCsv, parseOpts);
  const acftref = acftrefCsv ? csvParse(acftrefCsv, parseOpts) : [];

  // model lookup by MFR MDL CODE
  const modelByCode = new Map();
  for (const r of acftref) {
    const code = (r["CODE"] || r["MFR MDL CODE"] || "").trim();
    if (!code) continue;
    const mfr = (r["MFR"] || "").trim();
    const model = (r["MODEL"] || "").trim();
    modelByCode.set(code, [mfr, model].filter(Boolean).join(" "));
  }

  const matches = [];
  for (const r of master) {
    const name = (r["NAME"] || "");
    if (!name) continue;
    if (!patternRes.some((re) => re.test(name))) continue;
    const hex = (r["MODE S CODE HEX"] || "").trim().toLowerCase();
    if (!hex || !/^[0-9a-f]{6}$/.test(hex)) continue; // need a valid ICAO hex
    const nnum = (r["N-NUMBER"] || "").trim();
    const code = (r["MFR MDL CODE"] || "").trim();
    matches.push({
      icao24: hex,
      registration: nnum ? "N" + nnum : "",
      operator: (r["NAME"] || "").trim(),
      aircraft_type: modelByCode.get(code) || "",
      source: "faa",
    });
  }

  // de-dup by icao24
  const byIcao = new Map();
  for (const m of matches) byIcao.set(m.icao24, m);
  const list = [...byIcao.values()].sort((a, b) => (a.operator + a.registration).localeCompare(b.operator + b.registration));

  console.log(`\nMatched ${list.length} airframe(s) across ${new Set(list.map((m) => m.operator)).size} operator name(s).`);
  const byOp = {};
  for (const m of list) byOp[m.operator] = (byOp[m.operator] || 0) + 1;
  for (const [op, n] of Object.entries(byOp).sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(4)}  ${op}`);

  // Write data/seeders.json
  const outJson = path.join(__dirname, "data", "seeders.json");
  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.writeFileSync(outJson, JSON.stringify({ generated_at: new Date().toISOString(), count: list.length, aircraft: list }, null, 2));
  console.log(`\nWrote ${outJson}`);

  // Upsert into seeder_registry
  const db = new Database(cfg.DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS seeder_registry (
    icao24 TEXT PRIMARY KEY, registration TEXT, operator TEXT, aircraft_type TEXT,
    source TEXT, added_at TEXT DEFAULT (datetime('now')))`);
  const up = db.prepare(`INSERT INTO seeder_registry (icao24, registration, operator, aircraft_type, source)
    VALUES (@icao24,@registration,@operator,@aircraft_type,@source)
    ON CONFLICT(icao24) DO UPDATE SET registration=excluded.registration, operator=excluded.operator,
      aircraft_type=excluded.aircraft_type, source=excluded.source`);
  const tx = db.transaction(() => {
    // Rebuild the FAA-sourced rows from scratch so a re-run reflects the current
    // (corrected) patterns and drops any earlier false positives. Manual pins
    // (source!='faa') are untouched.
    db.prepare("DELETE FROM seeder_registry WHERE source = 'faa'").run();
    for (const m of list) up.run(m);
  });
  tx();
  const total = db.prepare("SELECT COUNT(*) n FROM seeder_registry").get().n;
  db.close();
  console.log(`Upserted into seeder_registry. Registry now holds ${total} airframe(s).`);
  console.log(`\nDone.`);
  console.log(`• Local run? Commit data/seeders.json — the collector loads it on deploy:`);
  console.log(`    git add data/seeders.json && git commit -m "update seeder registry" && git push`);
  console.log(`• In-container run? It already wrote the DB table; no commit needed.`);
  console.log(`The collector matches live icao24 against this registry on its next cycle.`);
}

main().catch((e) => { console.error("Importer error:", e.message); process.exit(1); });
