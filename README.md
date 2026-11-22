# Route Weather

Route Weather by Andy's Dev Studio plans drives around weather and road conditions. The Android app and browser demo use the same map, planner and forecast interface.

[Try the browser demo](https://route-weather.andy-596.workers.dev/) · [Andy's Dev Studio](https://andysdevstudio.pages.dev/) · [Privacy policy](https://route-weather.andy-596.workers.dev/route-weather-privacy.html)

## Source and license

Route Weather is licensed under the [GNU General Public License, version 3](LICENSE). The [v0.21 source ZIP](https://github.com/kayrugold/route-weather/archive/refs/tags/v0.21.zip) contains the source and build files for the Android 0.21 release and the corresponding browser demo. [Third-party notices](THIRD_PARTY.md) cover the bundled dependencies and link to their sources. Leaflet Rotate's full upstream source and build configuration are included in the repository.

## Project layout

- `assets/` contains the shared interface, map layers, route planner, speech logic and licenses.
- `android/` contains the native Android wrapper, bridge and Gradle project.
- `cloud/` contains the Cloudflare Worker, TomTom proxy, quotas and tests. `cloudflare.config.ts` configures the Worker.
- `third-party/` contains the source archive for the bundled Leaflet Rotate plugin.

## Build Android

Install JDK 17, Gradle 8.11.1, Android SDK Platform 36 and Build Tools 36.1.0. Set `ANDROID_HOME` to the SDK path. From the repository root:

```sh
gradle -p android -ProuteWeatherServiceOrigin=https://your-worker.example assembleDebug bundleRelease
```

Set `routeWeatherServiceOrigin` to the HTTPS origin of a Route Weather Worker, with no path or trailing slash. The debug APK is at `android/app/build/outputs/apk/debug/app-debug.apk`. The release Android App Bundle is at `android/app/build/outputs/bundle/release/app-release.aab`. Sign a release with your own upload key. The app targets API 36 and supports Android 8.0 (API 26) and later.

## Build the browser demo and Worker

Use Node.js 22.18 or later. From the repository root:

```sh
npm ci
npm test
npx cf build
```

For a separate deployment, set the Worker name and matching Durable Object binding in `cloudflare.config.ts`, add `TOMTOM_API_KEY` as a Worker secret, and deploy into your own Cloudflare account. TomTom geocoding, reverse geocoding, routing and traffic require access to the corresponding APIs. Configure budgets to match your provider account. Keep provider keys and signing material in your own environment.

## Address search

The planner's `buildTrip()` calls `geocode()` in `assets/index.html`. Saved or pinned endpoints and coordinate input are handled locally. Text queries go through the Worker's `/api/search` endpoint in the browser and `/app-api/search` on Android. The Worker applies quota and rate limits and calls TomTom through `cloud/tomtom.mjs`. Exact place names can resolve directly. Ambiguous matches open a chooser.
