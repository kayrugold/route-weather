# Route Weather — Offline Navigation Architecture

## 1. Selected Architecture
Route Weather uses a **modular, pure-Java + Android SQLite + PMTiles** offline navigation stack that plugs directly into the existing **Android WebView + Leaflet** application with **zero C++/NDK native dependencies** and **zero disruption** to existing weather, radar, fire, scanner, and TomTom features.

```text
+----------------------------------------------------------------------+
|  Route Weather WebView (Leaflet + Existing Vector-Tile Renderer)     |
|                                                                      |
|  assets/index.html ──▶ assets/network.js ──▶ assets/offline-nav.js   |
|     │                        │                                       |
|     │ /offline-tiles/z/x/y   │ /api/route, /api/search               |
|     ▼                        ▼                                       |
+-----│------------------------│---------------------------------------+
      │ shouldInterceptRequest │ @JavascriptInterface (AndroidRoute)
      ▼                        ▼
+----------------------------------------------------------------------+
|  MainActivity.java ──▶ OfflineEngine.java                            |
|    ├── PMTilesReader.java          (Pure Java PMTiles v3 MVT reader) |
|    ├── OfflineRouter.java          (BRouter v1.7.10, 338 KB JAR)     |
|    ├── OfflineSearchStore.java     (Android built-in SQLite FTS5)    |
|    └── OfflinePackageManager.java  (Cloudflare R2 Range + SHA-256)   |
+----------------------------------------------------------------------+
```

## 2. Why This Architecture Beat the Alternatives

| Criterion | Selected Stack (PMTiles + BRouter + SQLite FTS5) | Organic Maps (`.mwm`) | MapLibre + Valhalla |
| :--- | :--- | :--- | :--- |
| **Commercial Freemium & GPLv3 Licensing** | **Clean** (ODbL + MIT + BSD + Public Domain) | **Problematic** (prebuilt `.mwm` restricted by `DATA_LICENSE.txt`) | Clean (MIT/BSD/ODbL) |
| **Existing Leaflet + Weather Overlay Compatibility** | **100% native** — feeds directly into Route Weather's existing OpenMapTiles canvas renderer in `assets/index.html` | **Requires full rewrite** of all Leaflet weather/radar/fire/scanner layers into C++ OpenGL/Vulkan | Requires replacing Leaflet or dual-map sync |
| **Android Build Complexity** | **Minimal** — pure Java, single 338 KB JAR (`brouter-1.7.10-ro.jar`), zero NDK | Very high (multi-GB C++ NDK build) | High (C++ NDK build for Valhalla) |
| **Cross-State / Cross-Region Routing** | **Native** — BRouter 5°×5° `.rd5` tiles route across state lines automatically | Native | Native (tiled) |
| **Car vs. Truck Profile Separation** | **Explicit** (`car-fast.brf` vs. `truck.brf` + mandatory OSM disclaimer) | Basic | Good |
| **Future Digital CB Compatibility** | **Zero conflict** — leaves microphone, Bluetooth audio, foreground audio services, Android TTS, and WebSocket/WebRTC completely open | Potential audio/threading complexity | No conflict |

## 3. Component Details

### A. Vector Maps (`PMTilesReader.java`)
- Pure-Java PMTiles v3 reader (~210 lines, zero external libraries).
- Reads multiple installed regional `.pmtiles` archives directly via `RandomAccessFile` + Hilbert curve tile lookup + bounded 32-entry LRU leaf directory cache (< 4 MB RAM).
- Fast header bounding-box check (`mightContainTile`) routes each tile request to the matching state archive in microseconds.
- Served to WebView via `MainActivity.shouldInterceptRequest` at `https://appassets.androidplatform.net/offline-tiles/{z}/{x}/{y}.mvt`.
- Driving-optimized Planetiler profile strips `building`, `housenumber`, `landuse`, `landcover`, `aerodrome_label`, `mountain_peak`, and `poi` while keeping `transportation`, `transportation_name` (road names, highway shields, motorway exits), `place` (cities, towns, villages), `water`, `waterway`, `boundary`, and `park`.

### B. Offline Routing (`OfflineRouter.java` + BRouter)
- Wraps BRouter v1.7.10 (`brouter-1.7.10-ro.jar`, 337.7 KB, MIT license).
- Converts BRouter GeoJSON + `voicehints` into Route Weather's exact `/api/route` JSON contract (`code`, `waypoints`, `routes[].distance`, `duration`, `geometry`, `legs[].steps[]`, `legs[].annotation.duration`), preserving full compatibility with `assets/voice-guidance.js`, off-route detection, waypoints, and Android TTS.
- **Explicit profile separation:**
  - `car` (`assets/offline-profiles/car-fast.brf`): standard passenger car routing.
  - `truck` (`assets/offline-profiles/truck.brf`): favors interstates/US/state highways, penalizes residential/unpaved/service cut-throughs, respects OSM `hgv=no` where tagged, and always attaches `truckDisclaimer` warning that OSM commercial restrictions are incomplete and drivers must obey posted signs.

### C. Offline Search (`OfflineSearchStore.java`)
- Uses Android's built-in `SQLiteDatabase` with **FTS5** (`content='places'` external content table — zero duplicated text) and a `(category, lat, lon)` spatial index.
- Searches cities, towns, villages, streets/highways, street addresses, fuel stations, truck stops (with brand recognition: Pilot, Love's, TA, Petro, Flying J, etc.), weigh stations, rest areas, truck parking, hospitals, lodging, and food.
- Returns the exact `/api/search` and `/api/search?mode=facilities` JSON schemas expected by `assets/index.html`.

### D. Package Download & Integrity (`OfflinePackageManager.java`)
- Downloads `.pmtiles`, `.rd5`, and `-search.db` files directly from Cloudflare R2 over HTTPS.
- Supports HTTP `Range` pause/resume, interrupted download recovery (`.part` files in `tmp/`), available-storage checks (`StatFs` + 250 MB safety buffer), SHA-256 verification before atomic `renameTo` install, startup magic-byte corruption detection, and clean package deletion.

### E. JavaScript Provider Abstraction (`assets/offline-nav.js` + `assets/network.js`)
- `window.routeWeatherOffline` exposes `getMode()`/`setMode('auto' | 'online' | 'offline')`, `getProfile()`/`setProfile('car' | 'truck')`, `getStatus()`, `route()`, `search()`, `downloadPackage()`, `pauseDownload()`, and `deletePackage()`.
- In `'auto'` mode (default), online TomTom is used when connected, and Route Weather automatically falls back to the offline engine whenever the device is offline or TomTom is unreachable.
- TomTom remains 100% intact as an independent online provider.
