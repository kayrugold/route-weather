# Route Weather 0.20 laptop handoff

Open this extracted folder in Codex on your laptop. On Windows, use a Linux shell in WSL for the test APK build.

- `assets/` contains the exact editable HTML, JavaScript, CSS, data and bundled dependencies from the 0.20 Android APK. Start in `assets/index.html` and `assets/provider-worker.js` when tracing Android search. Android provider requests can go through the native bridge in `assets/network.js`. Changes to web code in the legacy folder do not flow into these Android assets automatically.
- `Route-Weather-Android-0.20.apk` is the original test APK. The rebuild script preserves its compiled Android wrapper and resources and replaces its web assets with the contents of `assets/`.
- `legacy-source/Route-Weather/` is the earlier source archive. It contains the original Java wrapper, the website source and a Cloudflare Worker example. It predates the native location and bridge changes in 0.20. Use it as a reference when bringing the Android and web sources together.
- The original editable Java source for the 0.20 wrapper and the Play upload key are not included. This handoff produces test APKs. To change native code or build an Android App Bundle, recover that later Java source or update the earlier wrapper to match the 0.20 bridge and verify on-device behavior.

## Rebuild after editing the web assets

Install a JDK, zip, and Linux Android SDK Build Tools 34.0.0. From this folder run:

```bash
export ANDROID_SDK_ROOT="$HOME/Android/Sdk" # Adjust to your SDK location.
bash ./build-test-apk.sh
```

If the SDK tools are elsewhere, set `ANDROID_BUILD_TOOLS` to the directory containing `zipalign` and `apksigner`. The output is `dist/Route-Weather-0.20-local.apk`. The script generates a local debug signing key on the first build. This APK uses the same test package name as 0.20. If the existing phone installation was signed with a different key, Android will reject an in-place update. Use a separate test device or back up settings before uninstalling the earlier APK, as uninstalling clears its data.

For the first laptop session, verify the test rebuild and trace address search. Keep provider credentials in Cloudflare secrets. Do not put them in the web assets, APK or GitHub.

## Verified laptop build — November 21, 2026

Rebuilt with WSL and the installed SDK Build Tools 35.0.0 (set `ANDROID_BUILD_TOOLS` to `$HOME/Android/Sdk/build-tools/35.0.0`). Signature and zip alignment verification passed. Output: `dist/Route-Weather-0.20-local.apk`. Package inspection confirms `com.andysdevstudio.routeweather.test`, version code 20, version name 0.20, min SDK 26, target SDK 34. This is a locally signed test APK, not a Play release. Phone behavior has not yet been tested in this session.

About now links to Andy's Dev Studio and the bundled map-library license notices. The packaged HTML was checked against the edited source. This is an initial credit update, not a completed attribution audit.

## Address search wiring

The flow below describes the original 0.20 APK. The current source sends search, routing and road lookup to the Route Weather Cloudflare Worker instead.

1. In `assets/index.html`, the planner submit handler calls `buildTrip()`, which calls `geocode()` for start, destination and optional via address. Menu Search opens the planner.
2. `geocode()` handles map pins and latitude/longitude locally; other input calls `api('/api/search?q=...')`. Multiple results open `chooseLocation()`.
3. `assets/network.js` intercepts same-origin `/api/` fetches and invokes `window.routeWeatherWorker.fetch()` inside the app.
4. `assets/provider-worker.js` handles `/api/search`, validates query length, spaces searches by 1.1 seconds in that app instance, and requests Nominatim JSON with US-only results and a limit of five.
5. Its upstream fetch is `window.routeProviderFetch`, which calls `AndroidRoute.fetch()`. Native replies return through `window.routeWeatherReply()`.

Despite its name, this bundled provider-worker is not a deployed Cloudflare Worker. The native bridge forwards Accept but not the JavaScript User-Agent or Cloudflare cache options; native behavior must be verified separately. A Cloudflare cache TTL in this code does not establish a shared search cache.

## Production preparation remaining

- The `android/` Gradle project ports the legacy wrapper to the current assets and adds the native location bridge. It compiles and targets API 36. The debug variant is `com.andysdevstudio.routeweather.debug` so it can coexist with the original 0.20 test package. The release variant proposes `com.andysdevstudio.routeweather`; verify the package against Play Console before uploading. Version 0.21 uses code 21. Play upload signing remains pending.
- Move provider access behind a shared backend with fixed endpoints, private TomTom secrets, abuse controls, quota limits and useful quota-exhaustion messages. Remove the end-user key setup once the backend is live. A key embedded in an APK is extractable.
- Nominatim's public limit is application-wide, not per phone: https://operations.osmfoundation.org/policies/nominatim/ . The current per-instance delay is insufficient for a public rollout. Provider switching must be possible without app updates. Choose the production search provider before deployment.
- TomTom permits commercial API use during free evaluation, but account allowances and key restrictions still need inspection: https://docs.tomtom.com/platform/documentation/status-and-support/faqs . Current pricing: https://docs.tomtom.com/pricing . Do not enable paid top-ups or upgrades under the zero-new-spending constraint.
- Cloudflare Workers Free offers 100,000 requests/day; static asset requests are free and unlimited: https://developers.cloudflare.com/workers/platform/pricing/ . Design for limits; this is not unlimited free live traffic.
- Build the browser demo from the current UI with a browser transport to the shared backend. The current Android assets require native bridge calls, and the legacy web source predates 0.20. GitHub can hold source; Cloudflare can host the demo and API. Existing deployment location remains unverified. A GitHub search for `user:kayrugold route` returned no matches; this does not exclude code inside another repository.
- Audit service policies for map tiles, offline downloads, OSRM routing, scanner/radio feeds and other data sources. Finish provider attribution and privacy disclosures. `assets/licenses/leaflet-rotate.txt` contains GPLv3; address corresponding-source obligations before distribution.
- Complete on-device testing, Play privacy/Data safety disclosures, content rating, store listing and any account-specific testing requirements in Andy's Dev Studio's existing organization account. Set the intended paid price to $9.99 when preparing the listing.

## Build and test the API 36 wrapper

With JDK 17, Gradle 8.11.1, the Android 36 platform and SDK Build Tools 36.1.0 installed, set `ANDROID_HOME` to the SDK path and run from the project root:

```sh
gradle -p android assembleDebug bundleRelease
```

The debug APK is at `android/app/build/outputs/apk/debug/app-debug.apk`. The release bundle at `android/app/build/outputs/bundle/release/app-release.aab` requires a Play upload signature. When using a cached WSL install offline, add `--offline -Pandroid.aapt2FromMavenOverride="$ANDROID_HOME/build-tools/36.1.0/aapt2"` if Gradle cannot resolve the AAPT2 binary. Release lint also needs its dependencies cached for offline use.

On November 21, 2026, the Note 20 (Android 13) successfully installed and launched the debug build alongside the earlier signed APK. The on-device build returned an Anderson, CA address match, calculated an OSRM route, acquired a native GPS fix with one-time location permission, and rendered a planned route with three forecast points. Android 16 behavior, traffic, scanner/radio and release signing remain unverified.

## TomTom rollout and browser demo

Both clients use the same `assets/` source. The browser uses same-origin requests to `/api/`. The Android bridge sends search, routing, road lookup and studio traffic to `/app-api/` on the configured Worker origin. Android still requests NWS forecasts directly through its existing provider bridge. The browser requests weather through the Worker.

- Run `npm ci`, `npm test` and `npx cf build` before deploying. Use `npx cf auth login` for the studio account and review `npx cf deploy --dry-run` before deploying.
- Create `TOMTOM_API_KEY` as a Worker secret. Enable Geocoding, Routing and Reverse Geocoding on that key. Verify the plan's real allowances and test the domain whitelist from the Worker. Keep the key out of Git, Gradle, web files, and chat. Keep the account on the intended no-spend plan.
- Configure the Android build with `-ProuteWeatherServiceOrigin=https://<worker-host>`. This value is a public service URL. Verify on a clean install with no saved keys: two addresses, a route with a via point, directions, and several route forecast points.
- Host the live demo on the Worker. GitHub holds the source. Embed the Worker page on the project site using an iframe with its title set to “Route Weather live demo”. Location access inside the iframe also depends on the parent page's browser permissions policy. Direct opening is available if the embedded browser denies location.
- The SQLite Durable Object reserves a call before the Worker forwards it. Demo requests count towards both the demo cap and the shared total. The current Android URL is public and is not proof of Play purchase. Add app attestation or equivalent abuse protection before depending on the app budget as reserved for legitimate Android users.
- Studio-funded traffic is available as an Android option when `STUDIO_TRAFFIC` is `on`. It is off in the current config, uses a separate cap, and the browser demo cannot use its traffic endpoint. Verify a live tile before enabling it. The existing personal-key option is still available.
- The earlier 0.21 unsigned bundle and Note 20 install precede this provider change. Rebuild and sign using the verified Worker URL before any Play upload.
