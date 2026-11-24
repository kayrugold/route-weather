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
db.exec('BEGIN');
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
  insert.run(parts[0], parts[1], cat, parts[3], lat, lon, rank);
  count++;
}
db.exec('COMMIT');
console.log('Source category counts:', counts);

console.log(`Inserted ${count.toLocaleString()} places. Building FTS5 + spatial indexes...`);
db.exec(`
  CREATE INDEX idx_places_cat_lat_lon ON places(category, lat, lon);
  CREATE VIRTUAL TABLE places_fts USING fts5(
    name, subtitle, brand,
    content='places', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  );
  INSERT INTO places_fts(places_fts) VALUES('rebuild');
  INSERT INTO places_fts(places_fts) VALUES('optimize');
  VACUUM;
`);

// Smoke-test key queries right here
const probe = db.prepare(`
  SELECT p.name, p.subtitle, p.category, p.lat, p.lon
  FROM places_fts JOIN places p ON p.id = places_fts.rowid
  WHERE places_fts MATCH ?
  ORDER BY bm25(places_fts) ASC, p.rank DESC LIMIT 3
`);

for (const q of ['anderson* ca*', 'stockton* ca*', 'pilot*']) {
  const rows = probe.all(q);
  console.log(`Query "${q}" ->`, rows.map(r => `${r.name} (${r.subtitle}) [${r.lat}, ${r.lon}]`).join(' | '));
}

db.close();
const sizeMb = (fs.statSync(dbPath).size / (1024 * 1024)).toFixed(2);
console.log(`Built ${dbPath}: ${sizeMb} MB (${count.toLocaleString()} records) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
