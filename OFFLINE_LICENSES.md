# Route Weather — Offline Navigation Licenses & Commercial Distribution

Route Weather is a commercial freemium application (currently licensed under **GPLv3** in `LICENSE`). Every offline mapping, routing, and search dependency below has been audited for **commercial distribution** and **GPLv3 compatibility**.

## Dependency & Data Inventory

| Component | Version / Source | License | Commercial Use | Redistribution & Attribution Obligations |
| :--- | :--- | :--- | :--- | :--- |
| **OpenStreetMap Data** | Geofabrik Regional Extracts (`*.osm.pbf`) | **ODbL 1.0** | Permitted | Must display visible attribution (`© OpenStreetMap contributors`) linking to `https://www.openstreetmap.org/copyright`. Any public derivative database (such as generated `.pmtiles`, `.rd5`, or `-search.db`) must remain under ODbL or provide a transformation script/recipe. |
| **Planetiler** (build tool only, not shipped in APK) | v0.10.2 (`onthegomap/planetiler`) | **Apache 2.0** | Permitted | Build-time tool only; generated tiles carry OSM ODbL + OpenMapTiles schema attribution. |
| **OpenMapTiles Vector Schema** | Bundled in Planetiler | **CC-BY 4.0 / BSD-3-Clause** | Permitted | Include attribution `© OpenMapTiles` alongside `© OpenStreetMap contributors` (already present in `assets/index.html`). |
| **PMTiles v3 Format & Reader** | Custom pure-Java `PMTilesReader.java` implementing PMTiles v3 spec | **BSD-3-Clause** (spec) / **GPLv3** (Route Weather) | Permitted | No third-party runtime JAR required; spec is BSD-3-Clause. |
| **BRouter Engine** (`brouter-1.7.10-ro.jar`) | v1.7.10 (`abrensch/brouter`) | **MIT** | Permitted | Include MIT copyright notice in `THIRD_PARTY.md` and app About/Licenses dialog. Commercial use and redistribution fully permitted. |
| **BRouter Profiles** (`car-fast.brf`, `truck.brf`, `lookups.dat`) | Derived from BRouter v1.7.10 | **MIT** | Permitted | Retain MIT notice; `truck.brf` is an original Route Weather profile derived from `car-fast.brf`. |
| **SQLite FTS5** (`OfflineSearchStore.java`) | Android Built-in `android.database.sqlite` | **Public Domain** (SQLite) / **Apache 2.0** (Android SDK) | Permitted | Built into Android OS; zero third-party binary shipped. |
| **Leaflet + Vector Tile JS** (`leaflet.js`, `leaflet-rotate.js`, `vector-tile.mjs`, `pbf.mjs`, `point.mjs`) | Existing Route Weather bundled assets | **BSD-2-Clause / ISC / GPLv3** | Permitted | Existing notices preserved in `assets/licenses/` and `THIRD_PARTY.md`. |

## Explicitly Excluded / Prohibited Data Sources
- **Organic Maps prebuilt `.mwm` binaries:** Not used (separate `DATA_LICENSE.txt` restricts commercial redistribution of prebuilt `.mwm` files).
- **TomTom online data:** Remains strictly online-only via `cloud/tomtom.mjs`; never cached or redistributed for offline map packages.
- **Public OSM raster/vector tile servers:** Never bulk-scraped; all offline packages are generated reproducibly from Geofabrik `.osm.pbf` extracts.

## Required In-App Attribution
Display in the map attribution bar and About dialog whenever offline maps are active:
> `Map data © OpenStreetMap contributors (ODbL) · Schema © OpenMapTiles · Offline routing powered by BRouter (MIT)`
