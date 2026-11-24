# Route Weather — Offline Map Generation Pipeline

All heavy OpenStreetMap preprocessing runs on a development laptop or CI build machine — **never** on the user's Android device.

## 1. Hardware & Tool Requirements
- **RAM:** 8–16 GB RAM (individual US states build comfortably with `-Xmx6g` to `-Xmx8g`; 24 GB RAM allows building California or multi-state regions in minutes).
- **Disk:** ~15 GB free working space for regional builds (cleaned up after `.pmtiles` / `-search.db` / `.rd5` outputs are generated).
- **Tools:**
  - **Java 17+** (verified on Java 25 LTS)
  - **Node.js 22.18+** (with built-in `--experimental-sqlite`)
  - **Planetiler** (`v0.10.2`, `planetiler.jar`, Apache 2.0)
  - **BRouter** (`v1.7.10`, `brouter-1.7.10-all.jar` for self-building `.rd5` segments, MIT)
  - **Geofabrik** regional `.osm.pbf` extracts (`https://download.geofabrik.de/north-america/us.html`)

## 2. Pipeline Scripts (`tools/offline-maps/`)
- `tools/offline-maps/build-norcal.ps1` — End-to-end Northern California prototype builder & verifier.
- `tools/offline-maps/OsmSearchExtractor.java` — Extracts driving-relevant places, streets, addresses, truck stops, weigh stations, fuel, rest areas, hospitals, lodging, and food from any `.osm.pbf`.
- `tools/offline-maps/build-search-db.mjs` — Imports extracted TSV records into a compact, `VACUUM`'d **SQLite FTS5** database (`*-search.db`).
- `tools/offline-maps/VerifyOfflineEngine.java` — Verifies `PMTilesReader` tile reads and BRouter routing (`car-fast.brf` + `truck.brf`) on **Anderson, CA → Stockton, CA**.
- `tools/offline-maps/generate-manifest.mjs` — Computes SHA-256 checksums, sizes, and outputs Cloudflare R2 `manifest.json`.

## 3. Running a State / Regional Build
### Step A: Vector Map (`.pmtiles`) — Driving-Optimized
Strips `building`, `housenumber`, `landuse`, `landcover`, `aerodrome_label`, `mountain_peak`, and `poi` layers from the vector tiles while retaining:
- `transportation` (all drivable roads from interstates down to residential streets)
- `transportation_name` (street names, highway shields, refs, motorway exit numbers)
- `place` (cities, towns, villages)
- `water`, `waterway`, `water_name`
- `boundary` (state & national borders)
- `park`

```powershell
java -Xmx8g -jar dist/offline-build/planetiler.jar `
  --osm-path=dist/offline-build/norcal-latest.osm.pbf `
  --output=dist/offline-build/norcal-package/norcal.pmtiles `
  --download `
  --data-dir=dist/offline-build/planetiler-data `
  --exclude-layers=building,housenumber,landuse,landcover,aerodrome_label,mountain_peak,poi `
  --force
```

### Step B: Offline Search Index (`*-search.db`)
```powershell
javac -cp dist/offline-build/planetiler.jar -d dist/offline-build/classes tools/offline-maps/OsmSearchExtractor.java
java -Xmx6g -cp "dist/offline-build/classes;dist/offline-build/planetiler.jar" OsmSearchExtractor `
  dist/offline-build/norcal-latest.osm.pbf dist/offline-build/norcal-search.tsv CA
node --experimental-sqlite tools/offline-maps/build-search-db.mjs `
  dist/offline-build/norcal-search.tsv dist/offline-build/norcal-package/norcal-search.db
```

### Step C: Routing Segments (`.rd5`)
BRouter segments are 5°×5° geographic tiles (`W125_N35.rd5`, `W125_N40.rd5`, etc.), which naturally allow seamless cross-state routing when multiple states are installed.
- For **commercial nationwide production**, self-build driving-pruned `.rd5` segments from Geofabrik `.osm.pbf` using BRouter's `btools.mapcreator.OsmCutter` / `NodeCutter` / `WayCutter` / `WayLinker` pipeline with a driving-only `lookups.dat` (omitting footpaths, hiking trails, cycleways, and SRTM elevation grids to cut `.rd5` size by ~40–50%).
- For the **Northern California prototype**, `build-norcal.ps1` validates routing with `W125_N35.rd5` and `W125_N40.rd5`.

### Step D: Manifest & SHA-256 Verification
```powershell
node tools/offline-maps/generate-manifest.mjs `
  2026.11-norcal-proto https://maps.routeweather.pages.dev `
  dist/offline-build/norcal-package dist/offline-build/norcal-package/manifest.json
```

## 4. Scaling to Lower 48 (Incremental Per-State Builds)
1. Download each state's `.osm.pbf` from Geofabrik (`north-america/us/<state>-latest.osm.pbf`).
2. Run Steps A–D per state — each state builds independently in 1–5 minutes on a 16–24 GB laptop.
3. Also build one tiny `us-overview.pmtiles` (`--maxzoom=6`) for seamless nationwide zoom-out.
4. Upload each state directory to Cloudflare R2 under `releases/<VERSION>/north-america/usa/<state>/` and publish the combined `manifest.json` containing individual states, regional groups, and a one-tap "Lower 48 (All Continental US)" meta-package.
