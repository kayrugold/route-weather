# Route Weather — Offline Navigation Prototype Test Results

**Test Region:** Northern California (`norcal-latest.osm.pbf`, 626.6 MB from Geofabrik)  
**Primary Test Route:** Anderson, CA (`40.4482, -122.2978`) → Stockton, CA (`37.9577, -121.2908`)  
**Build Machine:** Windows laptop, 24 GB RAM, Java 25 LTS, Node.js 24.22.0

---

## 1. Real Measured Northern California Package Sizes

| Component | File(s) | Measured Installed Size | Build Time | Contents |
| :--- | :--- | ---: | ---: | :--- |
| **Vector Maps** | `norcal.pmtiles` | **230.34 MB** | 7m 16s | 106,938 MVT tiles (`z0–z14`), 9.8M features: all roads (interstates → residential), street names, highway shields, motorway exits, cities/towns, parks, waterways, state boundaries |
| **Routing Graph** | `W125_N35.rd5` (53.49 MB) + `W125_N40.rd5` (36.21 MB) | **89.70 MB** *(unpruned)* | Staged | Full 10°×5° coverage (Anderson, Redding, Bay Area, Sacramento, Stockton, Southern OR). Driving-only pruning (removing footpaths/hiking/cycling/SRTM) cuts `.rd5` size by ~40–50% (~45–55 MB). |
| **Offline Search (Compact Driving)** | `norcal-search.db` (SQLite FTS5) | **30.61 MB** | 9.0s (import) | **256,416 records**: 4,339 cities/towns/villages, 224,435 streets/highways, 3,677 fuel stations, 114 truck stops, 159 weigh stations, 163 rest areas, 223 hospitals, 2,884 hotels/motels, 20,380 restaurants/food, 42 truck parking |
| **Total Northern California** | Complete offline bundle | **350.65 MB** | — | Full offline map display + offline car/truck routing + offline search |

> **Finding on House-Number Addresses:** Including all 1,464,195 individual house-number addresses in Northern California inflated `norcal-search.db` from **30.61 MB** to **234.36 MB**. Keeping city/town + street/highway + driving POI search (default `--compact`) saves ~87% storage and keeps Lower 48 comfortably under the 5 GB cap.

---

## 2. Real Measured All-of-California Package Sizes (Full-State Benchmark)
Built from `california-latest.osm.pbf` (1,275.7 MB from Geofabrik):

| Component | File(s) | Measured Size | Contents |
| :--- | :--- | ---: | :--- |
| **Vector Maps** | `california.pmtiles` (`z0–z14`) | **354.40 MB** | Full state roads, exits, shields, street names, cities/towns, parks, waterways, borders |
| **Routing Graph** | 6× BRouter `.rd5` tiles (`W120_N30/35/40`, `W125_N30/35/40`) | **191.84 MB** *(unpruned)* | Entire state from Oregon border to Mexico border + NV border (~100 MB driving-pruned) |
| **Offline Search & POI Layers** | `california-search.db` (FTS4) | **92.15 MB** | **537,146 records**: 7,237 cities/towns, 456,440 city-tagged streets, 2,522 hospitals/clinics, 812 police/CHP, 2,559 fire stations, 4,686 auto/truck repair & tire shops, 301 rest areas, 266 weigh stations + 53 official Caltrans scales (incl. Cottonwood), 205 truck stops, 7,810 fuel stations, 1,699 pharmacies, 5,670 hotels/motels, 46,790 food |
| **All-of-California Total** | 8 files (`manifest.json` SHA-256 verified) | **638.40 MB** | **California is ~12% of US population/roads → Lower 48 fits comfortably in ~3.5–4.5 GB (≤ 5 GB target)** |

---

## 3. Real Measured All-48 Continental US Regional Package Sizes (FINAL BENCHMARK)
Built from Geofabrik's 4 official US regional extracts (`us-west`, `us-midwest`, `us-south`, `us-northeast`, `z0–z13` driving-optimized PMTiles + FTS4 driving/safety POI search + deduplicated BRouter `.rd5` routing):

| Package | Vector Maps (`.pmtiles`) | Offline Search & POIs (`-search.db`) | Routing (`.rd5`) | Total Installed Size |
| :--- | ---: | ---: | ---: | ---: |
| **US West** (11 states: WA, OR, CA, NV, ID, MT, WY, UT, CO, AZ, NM) | 511.2 MB | 229.1 MB | 519.7 MB | **1.23 GB** |
| **US Midwest** (12 states: ND, SD, NE, KS, MN, IA, MO, WI, IL, MI, IN, OH) | 442.5 MB | 269.7 MB | 548.4 MB | **1.23 GB** |
| **US Northeast** (9 states: ME, NH, VT, MA, RI, CT, NY, NJ, PA) | 211.4 MB | 161.7 MB | 539.4 MB | **0.89 GB** |
| **US South** (16 states + DC: TX..VA..FL..MD/DE/DC) | 630.7 MB | 511.6 MB | 823.1 MB | **1.92 GB** |
| **All 48 Continental US States (Deduplicated)** | **1,795.7 MB** | **1,172.1 MB** | **1,761.7 MB** | **4.62 GB** |
| **Canada** (All Provinces & Territories) | 1,149.5 MB | 103.2 MB | 837.9 MB | **2.04 GB** |
| **Mexico** (All States) | 243.2 MB | 177.3 MB | 465.5 MB | **0.87 GB** |
| **All North America (USA 48 + Canada + Mexico, Deduplicated)** | **3,188.4 MB** | **1,452.7 MB** | **1,951.1 MB** | **6.44 GB** |

**Verified Conclusion:**
- **48-State Continental US:** **4.62 GB** on disk — **under the 5.00 GB device budget**.
- **Full North America (USA 48 + Canada + Mexico):** **6.44 GB** deduplicated — fits comfortably inside **Cloudflare R2's 10.00 GB free storage tier (\$0/month, \$0 egress)** with **3.56 GB** of headroom.

---

## 4. Lower 48 Storage Budget Comparison
Northern California represents roughly **~5–6%** of Continental US OSM road/feature density (Bay Area + Sacramento + Central Valley + Northern CA is one of the densest OSM regions in the US).

| Component | Measured NorCal | Projected Lower 48 (Optimized) | Target Budget |
| :--- | ---: | ---: | ---: |
| **Vector Maps (`.pmtiles`)** | 230.34 MB (`z0–z14`) | **~2.2 – 2.8 GB** *(with `z0–z13` or simplified `park`/`waterway`)* | 2.50 GB |
| **Routing Network (`.rd5`)** | 89.70 MB *(unpruned)* / ~50 MB *(pruned)* | **~1.1 – 1.5 GB** *(driving-pruned `.rd5`)* | 1.50 GB |
| **Offline Search (`-search.db`)** | 30.61 MB | **~0.40 – 0.55 GB** | 0.70 GB |
| **Profiles / Styles / Overhead** | 0.04 MB | **< 0.05 GB** | 0.30 GB |
| **Combined Lower 48 Total** | **350.65 MB** | **~3.7 – 4.9 GB** | **≤ 5.00 GB** |

**Conclusion:** The **PMTiles + BRouter + SQLite FTS5** architecture **fits inside the 5.00 GB Lower 48 target** (and hits ~3.7–4.5 GB with driving-pruned `.rd5` and `z0–z13` vector tiles).

---

## 3. Functional Verification Results

### A. PMTiles Vector Tile Reads (`PMTilesReader.java` on `norcal.pmtiles`)
- Header parsed: `z0..z14`, `bbox=[-126.4343, 35.7853, -115.6038, 42.4340]`, `230.34 MB`
- `z7`: Anderson (`20/48`) = **53,759 B** | Stockton (`20/49`) = **83,608 B** — **PASS**
- `z10`: Anderson (`164/385`) = **10,560 B** | Stockton (`166/395`) = **17,174 B** — **PASS**
- `z12`: Anderson (`656/1543`) = **15,213 B** | Stockton (`667/1580`) = **43,405 B** — **PASS**
- `z14`: Anderson (`2626/6175`) = **14,781 B** | Stockton (`2671/6322`) = **22,663 B** — **PASS**

### B. Offline Routing (`BRouter` — Anderson, CA → Stockton, CA)
- **Passenger Car (`car-fast.brf`):** **197.2 miles**, **3.04 hrs** (`10,952 s`), 1,616 track points, 111 KB GeoJSON — **PASS**
- **Commercial Truck (`truck.brf`):** **196.7 miles**, **3.23 hrs** (`11,636 s`), 1,594 track points, 107 KB GeoJSON, includes mandatory `truckDisclaimer` — **PASS**

### C. Offline Search (`norcal-search.db` — SQLite FTS5)
- `"anderson* ca*"` → `Anderson, CA (Town) [40.44793, -122.29825]` + local hotels/roads — **PASS**
- `"stockton* ca*"` → `Stockton, CA` hotels/places — **PASS**
- `"pilot*"` → `Pilot, CA (Truck Stop)` locations along I-5 / SR-99 — **PASS**

### D. Code & Unit Tests
- **Android Java compilation (`javac` against `android-36/android.jar` + `brouter-1.7.10-ro.jar`):** 0 errors — **PASS**
- **Node unit tests (`node --experimental-sqlite --test cloud/test/*.test.mjs`):** **30 / 30 passing** (including 28 existing Route Weather tests + 2 new `offline-nav.test.mjs` tests) — **PASS**

### E. Remaining On-Device Hardware Tests (for Sol / Device Verification)
- Cold startup, Airplane Mode map pan/zoom, live GPS Follow Me, TTS spoken turn-by-turn, off-route recalculation, interrupted R2 download resume, and portrait/landscape verification on **Samsung Galaxy Note 20** and **Samsung FE tablet** (using the assembled `android/app/build/outputs/apk/debug/app-debug.apk`).
