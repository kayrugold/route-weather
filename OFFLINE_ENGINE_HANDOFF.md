# Route Weather — Offline Navigation Engine Handoff (to Sol)

## 1. Baseline & Git Status
- **Repository:** `c:\Users\kayru_tolw96q\Desktop\route-weather` (`https://github.com/kayrugold/route-weather.git`)
- **Baseline branch / commit:** `main` @ `d2b544874200d268e8ec0d78418b1de07f54cb0b`
- **Development branch:** `offline-navigation` @ `c4e7626b360ab173b8299c3cb139347e19fee4b1` (created via WSL `git`; `main` untouched, pre-existing uncommitted v0.32 work preserved).
- **Large map binaries:** All downloaded `.osm.pbf`, `planetiler.jar`, and generated `.pmtiles`/`.rd5`/`-search.db` files live inside `dist/offline-build/` (already listed in `.gitignore`).

## 2. Selected Architecture Summary
- **Vector Maps:** **Planetiler → PMTiles v3** (driving-optimized OpenMapTiles schema) served directly to Route Weather's existing Leaflet vector-tile canvas renderer via `MainActivity.shouldInterceptRequest` (`/offline-tiles/{z}/{x}/{y}.mvt`) backed by pure-Java `PMTilesReader.java`.
- **Offline Routing:** **BRouter v1.7.10** (`android/app/libs/brouter-1.7.10-ro.jar`, 337.7 KB, MIT license) reading 5°×5° `.rd5` segments with separate `car-fast.brf` and `truck.brf` profiles, returning Route Weather's exact `/api/route` JSON contract.
- **Offline Search:** **Android SQLite FTS5** (`OfflineSearchStore.java`) querying regional `*-search.db` indexes for cities, towns, streets, addresses, truck stops, weigh stations, fuel, rest areas, hospitals, lodging, and food.
- **Package Distribution:** **Cloudflare R2** (`routeweather-offline-maps`) with direct HTTPS `Range` downloads, pause/resume, SHA-256 verification, atomic install, and deletion via `OfflinePackageManager.java`.

## 3. Files Created & Modified

### Android Native (`android/app/`)
- `android/app/libs/brouter-1.7.10-ro.jar` — BRouter v1.7.10 read-only routing library (MIT, 337.7 KB)
- `android/app/build.gradle` — Added `implementation fileTree(dir: 'libs', include: ['*.jar'])`
- `android/app/src/main/MainActivity.java` — Wired `OfflineEngine`, `/offline-tiles/{z}/{x}/{y}.mvt` interceptor, and `@JavascriptInterface` bridge methods
- `android/app/src/main/com/andysdevstudio/routeweather/offline/PMTilesReader.java` — Pure-Java PMTiles v3 reader
- `android/app/src/main/com/andysdevstudio/routeweather/offline/OfflineSearchStore.java` — SQLite FTS5 offline search & facility store
- `android/app/src/main/com/andysdevstudio/routeweather/offline/OfflineRouter.java` — BRouter wrapper + Route Weather JSON adapter
- `android/app/src/main/com/andysdevstudio/routeweather/offline/OfflinePackageManager.java` — Resumable R2 downloader, SHA-256 verifier, atomic installer
- `android/app/src/main/com/andysdevstudio/routeweather/offline/OfflineEngine.java` — Unified facade

### Shared Web / JS Assets (`assets/`)
- `assets/offline-nav.js` — Provider abstraction (`window.routeWeatherOffline`: `auto`/`online`/`offline` mode, `car`/`truck` profile, download/delete controls)
- `assets/network.js` — Transparent `/api/search` and `/api/route` routing to offline engine when offline or in offline mode, preserving TomTom online
- `assets/index.html` — Loads `/offline-nav.js`, reads `/offline-tiles/{z}/{x}/{y}.mvt` down to z4 when offline PMTiles are installed, and renders offline city/town `place` labels
- `assets/offline-profiles/lookups.dat` — BRouter tag lookup table
- `assets/offline-profiles/car-fast.brf` — Passenger car routing profile
- `assets/offline-profiles/truck.brf` — Advisory commercial truck routing profile

### Map Generation Pipeline & Tests (`tools/offline-maps/`, `cloud/test/`)
- `tools/offline-maps/build-norcal.ps1` — End-to-end Northern California build & verification script
- `tools/offline-maps/OsmSearchExtractor.java` — OSM PBF driving search extractor
- `tools/offline-maps/build-search-db.mjs` — SQLite FTS5 database builder
- `tools/offline-maps/VerifyOfflineEngine.java` — End-to-end PMTiles + BRouter verifier
- `tools/offline-maps/generate-manifest.mjs` — SHA-256 + R2 `manifest.json` generator
- `cloud/test/offline-nav.test.mjs` — Unit tests for JS offline provider abstraction

### Documentation
- `OFFLINE_ARCHITECTURE.md`
- `OFFLINE_LICENSES.md`
- `MAP_GENERATION.md`
- `CLOUDFLARE_SETUP.md`
- `OFFLINE_TEST_RESULTS.md`
- `OFFLINE_ENGINE_HANDOFF.md`

## 4. JavaScript-to-Android Bridge Interfaces (`window.AndroidRoute`)
- `AndroidRoute.offlineStatus()` → JSON `{availableBytes, installedBytes, tileCount, routingCount, searchCount, hasTiles, hasRouting, hasSearch, packages: [...]}`
- `AndroidRoute.offlineSearch(query, mode, lat, lon, limit)` → `/api/search` JSON array
- `AndroidRoute.offlineFacilities(kind, west, south, east, north, offset)` → `/api/search?mode=facilities` JSON object
- `AndroidRoute.offlineRoute(coords, profile)` → `/api/route` JSON object (`profile`: `"car"` or `"truck"`)
- `AndroidRoute.offlineDownloadPackage(packageJson)` → Starts/resumes R2 download; pushes progress to `window.routeWeatherOfflineEvent(ev)`
- `AndroidRoute.offlinePauseDownload(packageId)` → Pauses active download (preserves `.part` file for HTTP Range resume)
- `AndroidRoute.offlineDeletePackage(packageId)` → Deletes installed package files and reloads readers
- `AndroidRoute.offlineReload()` → Reloads `.pmtiles`, `.rd5`, and `-search.db` from disk

## 5. Build Instructions
- **Node unit tests:** `node --experimental-sqlite --test cloud/test/*.test.mjs` (30/30 passing)
- **Android Debug APK (via WSL with OpenJDK 17 + Gradle 8.11.1):**
  ```sh
  export ANDROID_HOME=/home/kayrugold/Android/Sdk
  export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
  /home/kayrugold/.gradle/wrapper/dists/gradle-8.11.1-bin/bpt9gzteqjrbo1mjrsomdt32c/gradle-8.11.1/bin/gradle \
    -p android -ProuteWeatherServiceOrigin=https://route-weather.andy-596.workers.dev assembleDebug
  ```

## 6. Next Steps for Sol (Final UI Integration & Digital CB)
1. **Add Offline Maps UI dialog** in `assets/index.html` Menu:
   - Fetch `manifest.json` from the Cloudflare R2 domain, list states/regions/Lower 48, and bind Download / Pause / Delete buttons to `window.routeWeatherOffline.downloadPackage(...)`, `pauseDownload(...)`, and `deletePackage(...)`.
   - Subscribe to `window.routeWeatherOffline.onEvent(ev)` to render live download progress bars.
   - Add a **Navigation Mode** toggle (`Auto` / `Online` / `Offline`) and **Vehicle Profile** selector (`Car` / `Truck (Advisory)`) calling `setMode()` and `setProfile()`.
   - When a route returns `result.truckDisclaimer`, display it prominently in the route header/status bar.
2. **Create R2 bucket** (`routeweather-offline-maps`) after owner approval and upload generated state packages per `CLOUDFLARE_SETUP.md`.
3. **Hardware testing** on Samsung Galaxy Note 20 and Samsung FE tablet in Airplane Mode (follow `OFFLINE_TEST_RESULTS.md`).
4. **Digital CB compatibility:** No audio/mic/Bluetooth/foreground-service conflicts were introduced; `MainActivity.java` audio focus remains clean for future Channel 17/19 voice integration.
