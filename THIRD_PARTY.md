# Bundled dependencies

| Component | Version and source | Bundled license |
| --- | --- | --- |
| Leaflet Rotate | [0.2.8 source archive](third-party/leaflet-rotate-0.2.8.tgz), including the original JavaScript sources and Rollup configuration. The app ships the archive's `package/dist/leaflet-rotate.js` unchanged. | [GPLv3](assets/licenses/leaflet-rotate.txt) |
| Leaflet | [1.9.4 upstream source](https://github.com/Leaflet/Leaflet/tree/v1.9.4) | [BSD 2-Clause](assets/licenses/leaflet.txt) |
| pbf | [4.0.1 upstream package](https://registry.npmjs.org/pbf/-/pbf-4.0.1.tgz) | [BSD 3-Clause](assets/licenses/pbf.txt) |
| Mapbox point-geometry | [1.1.0 upstream package](https://registry.npmjs.org/@mapbox/point-geometry/-/point-geometry-1.1.0.tgz) | [ISC](assets/licenses/point-geometry.txt) |
| Mapbox vector-tile | [2.0.4 upstream package](https://registry.npmjs.org/@mapbox/vector-tile/-/vector-tile-2.0.4.tgz) | [BSD 3-Clause](assets/licenses/vector-tile.txt) |

The exact web assets consumed by the Android and browser builds are in `assets/`. To rebuild Leaflet Rotate independently, extract its archive, run `npm install` in the extracted `package/` directory, then run `npm run build`. Use the pinned bundled copy when building Route Weather 0.21.

The project's software license covers the code. Map imagery, weather and traffic data, and hosted API access are subject to the providers' own terms. The app displays map attribution and lists its providers in About.
