#!/usr/bin/env node
/**
 * Imports TSV records from OsmSearchExtractor into a compact SQLite FTS5 database
 * for Route Weather's OfflineSearchStore.
 *
 * Usage:
 *   node --experimental-sqlite tools/offline-maps/build-search-db.mjs <input.tsv> <output.db>
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

const [,, tsvPath, dbPath, flag] = process.argv;
const skipAddresses = flag === '--compact';
if (!tsvPath || !dbPath) {
  console.error('Usage: node --experimental-sqlite build-search-db.mjs <input.tsv> <output.db> [--compact]');
  process.exit(1);
}

if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
const t0 = Date.now();
const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA page_size = 4096;
  PRAGMA journal_mode = OFF;
  PRAGMA synchronous = OFF;
  PRAGMA temp_store = MEMORY;

  CREATE TABLE places (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    subtitle TEXT NOT NULL,
    category TEXT NOT NULL,
    brand TEXT DEFAULT '',
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    rank INTEGER NOT NULL DEFAULT 0
  );
`);

const insert = db.prepare(
  'INSERT INTO places (name, subtitle, category, brand, lat, lon, rank) VALUES (?, ?, ?, ?, ?, ?, ?)'
);

let count = 0;
const counts = {};
const rows = [];
const towns = [];
const rl = readline.createInterface({ input: fs.createReadStream(tsvPath, 'utf8'), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line) continue;
  const parts = line.split('\t');
  if (parts.length < 7) continue;
  const cat = parts[2];
  counts[cat] = (counts[cat] || 0) + 1;
  if (skipAddresses && cat === 'address') continue;
  const lat = Number(parts[4]);
  const lon = Number(parts[5]);
  const rank = Number(parts[6]) || 0;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  const row = [parts[0], parts[1], cat, parts[3], lat, lon, rank];
  rows.push(row);
  if (cat === 'place' && rank >= 70) {
    towns.push({ name: parts[0], lat, lon });
  }
}

function nearestTown(lat, lon) {
  let best = null, bestD2 = Infinity;
  for (const t of towns) {
    const dLat = t.lat - lat;
    const dLon = (t.lon - lon) * 0.78;
    const d2 = dLat * dLat + dLon * dLon;
    if (d2 < bestD2) { bestD2 = d2; best = t; }
  }
  return best && bestD2 < 0.25 ? best.name : '';
}

db.exec('BEGIN');
for (const row of rows) {
  let [name, subtitle, cat, brand, lat, lon, rank] = row;
  if ((cat === 'weigh_station' || cat === 'truck_stop' || cat === 'rest_area')
      && !name.includes(',') || /^(cat scale|weigh station|rest area|pilot|love'?s|ta|petro)(,\s*[A-Z]{2})?$/i.test(name)) {
    if (cat === 'weigh_station' || cat === 'truck_stop' || cat === 'rest_area') {
      const base = name.replace(/,\s*[A-Z]{2}$/, '');
      const near = nearestTown(lat, lon);
      if (near && !base.toLowerCase().includes(near.split(',')[0].toLowerCase())) {
        name = `${base} · ${near}`;
        subtitle = `${subtitle} · near ${near}`;
      }
    }
  }
  insert.run(name, subtitle, cat, brand, lat, lon, rank);
  count++;
}
db.exec('COMMIT');
console.log('Source category counts:', counts);

console.log(`Inserted ${count.toLocaleString()} places. Building FTS4 (Android-compatible) + spatial indexes...`);
db.exec(`
  CREATE INDEX idx_places_cat_lat_lon ON places(category, lat, lon);
  CREATE INDEX idx_places_name_lower ON places(lower(name));
  CREATE VIRTUAL TABLE places_fts USING fts4(
    content="places",
    name, subtitle, brand,
    tokenize=unicode61
  );
  INSERT INTO places_fts(places_fts) VALUES('rebuild');
  INSERT INTO places_fts(places_fts) VALUES('optimize');
  VACUUM;
`);

// Smoke-test key queries right here
const probe = db.prepare(`
  SELECT p.name, p.subtitle, p.category, p.lat, p.lon, p.rank
  FROM places_fts JOIN places p ON p.id = places_fts.docid
  WHERE places_fts MATCH ?
  ORDER BY p.rank DESC LIMIT 3
`);

for (const q of ['anderson* ca*', 'stockton* ca*', 'pilot*', 'cat* scale*']) {
  const found = probe.all(q);
  console.log(`Query "${q}" ->`, found.map(r => `${r.name} (${r.subtitle}) [${r.lat}, ${r.lon}]`).join(' | '));
}

db.close();
const sizeMb = (fs.statSync(dbPath).size / (1024 * 1024)).toFixed(2);
console.log(`Built ${dbPath}: ${sizeMb} MB (${count.toLocaleString()} records) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
