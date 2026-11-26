package com.andysdevstudio.routeweather.offline;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicLong;

import btools.router.FormatJson;
import btools.router.OsmNodeNamed;
import btools.router.OsmTrack;
import btools.router.RoutingContext;
import btools.router.RoutingEngine;

/**
 * Offline routing engine backed by BRouter (MIT license, pure Java).
 * Reads regional 5x5-degree .rd5 segments and outputs Route Weather's exact /api/route JSON schema.
 * Clearly distinguishes passenger-car routing ("car") from advisory commercial truck routing ("truck").
 */
public final class OfflineRouter {
    private static final String TAG = "RouteWeatherOfflineRouter";
    public static final String TRUCK_DISCLAIMER =
            "Advisory commercial truck routing uses community-mapped OpenStreetMap data. "
            + "Bridge clearances, weight limits, and truck bans may be incomplete — always obey posted signs.";

    private final File profilesDir;
    private final File segmentsDir;
    private final AtomicLong activeGeneration = new AtomicLong(0);
    private final Set<RoutingEngine> activeEngines = Collections.newSetFromMap(new ConcurrentHashMap<>());

    public void cancelActiveRoutes() {
        activeGeneration.incrementAndGet();
        terminateActiveEngines();
    }

    private void terminateActiveEngines() {
        for (RoutingEngine engine : activeEngines) {
            try { engine.terminate(); } catch (Exception ignored) {}
        }
        activeEngines.clear();
    }

    public OfflineRouter(Context context, File segmentsDir) {
        this.segmentsDir = segmentsDir;
        this.profilesDir = new File(context.getCacheDir(), "offline-profiles");
        this.profilesDir.mkdirs();
        copyAssetIfMissing(context, "offline-profiles/lookups.dat", new File(profilesDir, "lookups.dat"));
        copyAssetIfMissing(context, "offline-profiles/car-fast.brf", new File(profilesDir, "car-fast.brf"));
        copyAssetIfMissing(context, "offline-profiles/truck.brf", new File(profilesDir, "truck.brf"));
        copyAssetIfMissing(context, "offline-profiles/highway-corridor.brf", new File(profilesDir, "highway-corridor.brf"));
    }

    public boolean hasSegments() {
        File[] files = segmentsDir.listFiles((dir, name) -> name.endsWith(".rd5") && new File(dir, name).length() > 1024);
        return files != null && files.length > 0;
    }

    /**
     * Calculates an offline road route through 2..10 [lon, lat] waypoints.
     *
     * @param coords  list of [lon, lat] pairs
     * @param profile "car" (default) or "truck"
     * @return Route Weather /api/route compatible JSONObject
     */
    public JSONObject calculateRoute(List<double[]> coords, String profile) throws Exception {
        if (coords == null || coords.size() < 2 || coords.size() > 10) {
            throw new IllegalArgumentException("A route requires between 2 and 10 points.");
        }
        if (!hasSegments()) {
            throw new IllegalStateException("No offline routing map packages are installed for this area.");
        }

        boolean truck = "truck".equalsIgnoreCase(profile);
        File profileFile = new File(profilesDir, truck ? "truck.brf" : "car-fast.brf");
        if (!profileFile.isFile()) {
            throw new IllegalStateException("Routing profile missing: " + profileFile.getName());
        }

        long gen = activeGeneration.incrementAndGet();
        terminateActiveEngines();
        long started = System.currentTimeMillis();
        List<double[]> expandedCoords = InterstateCorridorPlanner.expandLongLegs(coords, segmentsDir);
        JSONObject result;
        if (expandedCoords.size() > coords.size()) {
            Log.i(TAG, "Long-distance corridor planned: " + coords.size() + " -> " + expandedCoords.size() + " waypoints");
            result = calculateMultiLegRoute(expandedCoords, coords, profileFile, truck, started, gen);
        } else {
            JSONObject geoJson = runSingleBRouter(coords, profileFile, 96, 45_000L, 2.2, 1.25, gen);
            long elapsedMs = System.currentTimeMillis() - started;
            result = convertGeoJsonToRouteWeather(geoJson, coords, truck, elapsedMs);
        }
        if (gen != activeGeneration.get()) {
            throw new CancellationException("Offline route cancelled by newer request.");
        }
        // Label the finalized primary route with its Interstate corridor summary (never attach unfinalized preview routes)
        if (coords.size() == 2) {
            List<InterstateCorridorPlanner.CorridorOption> alts =
                    InterstateCorridorPlanner.planAlternativeCorridors(coords.get(0), coords.get(1), segmentsDir, 1);
            if (!alts.isEmpty()) {
                JSONArray routes = result.optJSONArray("routes");
                if (routes != null && routes.length() > 0) {
                    routes.getJSONObject(0).put("summary", alts.get(0).label);
                }
            }
        }
        Log.i(TAG, "Offline route calculated (" + (truck ? "truck" : "car") + ") in "
                + (System.currentTimeMillis() - started) + " ms");
        return result;
    }

    private JSONObject runSingleBRouter(List<double[]> legCoords, File profileFile,
                                        int memoryClass, long timeoutMs,
                                        double pass1Coeff, double airCostFactor, long gen) throws Exception {
        if (gen != activeGeneration.get()) {
            throw new CancellationException("Offline route cancelled.");
        }
        try {
            return executeBRouterOnce(legCoords, profileFile, memoryClass, timeoutMs, pass1Coeff, airCostFactor, gen);
        } catch (IllegalStateException e) {
            if (gen != activeGeneration.get()) {
                throw new CancellationException("Offline route cancelled.");
            }
            String msg = e.getMessage() != null ? e.getMessage().toLowerCase(java.util.Locale.US) : "";
            // If a tapped waypoint lands on a disconnected frontage road island (e.g. South Frontage Rd next to I-90)
            // or non-truck road, try highway-corridor.brf first (snaps past frontage/service islands straight onto I-90!),
            // then car-fast.brf, then 4 quick nudges (~550m).
            if (legCoords.size() >= 2 && !msg.contains("timeout")
                    && (msg.contains("island") || msg.contains("not mapped") || msg.contains("no track found"))) {
                File hwyProfile = new File(profilesDir, "highway-corridor.brf");
                if (hwyProfile.isFile() && !hwyProfile.equals(profileFile)) {
                    try {
                        return executeBRouterOnce(legCoords, hwyProfile, memoryClass, Math.min(timeoutMs, 8_000L), 3.0, 1.4, gen);
                    } catch (Exception ignored) {}
                }
                if ("truck.brf".equals(profileFile.getName())) {
                    File carProfile = new File(profilesDir, "car-fast.brf");
                    if (carProfile.isFile()) {
                        try {
                            return executeBRouterOnce(legCoords, carProfile, memoryClass, Math.min(timeoutMs, 10_000L), 2.4, 1.3, gen);
                        } catch (Exception ignored) {}
                    }
                }
                double[][] offsets = {{0.005, 0}, {-0.005, 0}, {0, 0.005}, {0, -0.005}};
                int last = legCoords.size() - 1;
                double[] origEnd = legCoords.get(last);
                File retryProfile = hwyProfile.isFile() ? hwyProfile : profileFile;
                for (double[] off : offsets) {
                    if (gen != activeGeneration.get()) {
                        throw new CancellationException("Offline route cancelled.");
                    }
                    List<double[]> nudged = new ArrayList<>(legCoords);
                    nudged.set(last, new double[]{origEnd[0] + off[0], origEnd[1] + off[1]});
                    try {
                        return executeBRouterOnce(nudged, retryProfile, memoryClass, Math.min(timeoutMs, 5_000L), 2.8, 1.35, gen);
                    } catch (Exception ignored) {}
                }
            }
            throw e;
        }
    }

    private JSONObject executeBRouterOnce(List<double[]> legCoords, File profileFile,
                                          int memoryClass, long timeoutMs,
                                          double pass1Coeff, double airCostFactor, long gen) throws Exception {
        if (gen != activeGeneration.get()) {
            throw new CancellationException("Offline route cancelled.");
        }
        List<OsmNodeNamed> waypoints = new ArrayList<>(legCoords.size());
        for (int i = 0; i < legCoords.size(); i++) {
            double lon = legCoords.get(i)[0];
            double lat = legCoords.get(i)[1];
            OsmNodeNamed wp = new OsmNodeNamed();
            wp.name = i == 0 ? "from" : (i == legCoords.size() - 1 ? "to" : "via" + i);
            wp.ilon = (int) Math.round((lon + 180.0) * 1_000_000.0);
            wp.ilat = (int) Math.round((lat + 90.0) * 1_000_000.0);
            waypoints.add(wp);
        }

        RoutingContext rc = new RoutingContext();
        rc.localFunction = profileFile.getAbsolutePath();
        rc.carMode = true;
        rc.considerTurnRestrictions = false;
        rc.memoryclass = memoryClass;
        rc.pass1coefficient = pass1Coeff;
        rc.pass2coefficient = 0;
        rc.keyValues = new HashMap<>();
        rc.keyValues.put("turnInstructionMode", "3");

        RoutingEngine engine = new RoutingEngine(null, null, segmentsDir, waypoints, rc);
        engine.airDistanceCostFactor = airCostFactor;
        engine.quite = true;
        activeEngines.add(engine);
        try {
            if (gen != activeGeneration.get()) {
                throw new CancellationException("Offline route cancelled.");
            }
            engine.doRun(timeoutMs);
        } finally {
            activeEngines.remove(engine);
        }
        if (gen != activeGeneration.get()) {
            throw new CancellationException("Offline route cancelled.");
        }

        String err = engine.getErrorMessage();
        OsmTrack track = engine.getFoundTrack();
        if (track == null || track.nodes == null || track.nodes.size() < 2) {
            throw new IllegalStateException(err != null && !err.isEmpty()
                    ? "Offline routing failed: " + err
                    : "No offline road route found. Check that map packages cover the entire trip.");
        }
        return new JSONObject(new FormatJson(rc).format(track));
    }

    private static boolean isRequestedCoord(double[] pt, List<double[]> requestedCoords) {
        for (double[] r : requestedCoords) {
            if (Math.abs(r[0] - pt[0]) < 1e-4 && Math.abs(r[1] - pt[1]) < 1e-4) return true;
        }
        return false;
    }

    private JSONObject calculateMultiLegRoute(List<double[]> expandedCoords, List<double[]> requestedCoords,
                                              File profileFile, boolean truck, long started, long gen) throws Exception {
        int legCount = expandedCoords.size() - 1;
        // Cap to 3 low-priority threads x 32MB so WebView/UI stays silky smooth and never GC-thrashes.
        int threads = Math.min(3, Math.max(2, legCount));
        ExecutorService pool = Executors.newFixedThreadPool(threads, r -> {
            Thread t = new Thread(r, "brouter-leg");
            t.setPriority(Thread.MIN_PRIORITY);
            return t;
        });
        File highwayProfile = new File(profilesDir, "highway-corridor.brf");
        boolean hasHighwayProfile = highwayProfile.isFile();
        List<Future<JSONObject>> futures = new ArrayList<>(legCount);
        try {
            for (int i = 0; i < legCount; i++) {
                final double[] a = expandedCoords.get(i);
                final double[] b = expandedCoords.get(i + 1);
                final boolean isEndLeg = (i == 0 || i == legCount - 1);
                // Try fast highway-corridor.brf on all middle legs (including highway waypoints like I-90!)
                // with automatic fallback to full profile if a waypoint is on a local street.
                final boolean tryHighwayFirst = hasHighwayProfile && !isEndLeg;
                futures.add(pool.submit(() -> {
                    try {
                        if (tryHighwayFirst) {
                            try {
                                return executeBRouterOnce(Arrays.asList(a, b), highwayProfile, 32, 7_000L, 3.2, 1.45, gen);
                            } catch (CancellationException ce) {
                                throw ce;
                            } catch (Exception ignored) {
                                // Fall back to full profile if this leg requires a local/tertiary connector
                            }
                        }
                        return runSingleBRouter(Arrays.asList(a, b), profileFile, 32, 14_000L, 2.6, 1.35, gen);
                    } catch (CancellationException ce) {
                        throw ce;
                    } catch (Exception e) {
                        Log.w(TAG, "Sub-leg failed: " + e.getMessage());
                        return null;
                    }
                }));
            }

            List<JSONObject> legGeoJsons = new ArrayList<>(legCount);
            for (int i = 0; i < legCount; i++) {
                if (gen != activeGeneration.get()) {
                    throw new CancellationException("Offline route cancelled.");
                }
                legGeoJsons.add(futures.get(i).get());
            }

            // Fast single-step self-healing fallback (bounded to ~15s so a bad hub never stalls for minutes).
            List<JSONObject> stitchedLegs = new ArrayList<>();
            int i = 0;
            while (i < legCount) {
                if (gen != activeGeneration.get()) {
                    throw new CancellationException("Offline route cancelled.");
                }
                JSONObject cur = legGeoJsons.get(i);
                if (cur != null) {
                    stitchedLegs.add(cur);
                    i++;
                } else {
                    double[] a = expandedCoords.get(i);
                    double[] b = expandedCoords.get(i + 1);
                    try {
                        stitchedLegs.add(runSingleBRouter(Arrays.asList(a, b), profileFile, 96, 15_000L, 2.5, 1.3, gen));
                        i++;
                    } catch (CancellationException ce) {
                        throw ce;
                    } catch (Exception retryErr) {
                        if (i + 2 <= legCount) {
                            stitchedLegs.add(runSingleBRouter(
                                    Arrays.asList(a, expandedCoords.get(i + 2)),
                                    profileFile, 96, 18_000L, 3.0, 1.4, gen));
                            i += 2;
                        } else {
                            throw retryErr;
                        }
                    }
                }
            }

            long elapsedMs = System.currentTimeMillis() - started;
            return mergeGeoJsonsToRouteWeather(stitchedLegs, requestedCoords, truck, elapsedMs);
        } finally {
            pool.shutdownNow();
        }
    }

    static JSONObject mergeGeoJsonsToRouteWeather(List<JSONObject> geoJsons, List<double[]> requestedCoords,
                                                  boolean truck, long elapsedMs) throws JSONException {
        JSONArray combinedCoords = new JSONArray();
        JSONArray combinedVoiceHints = new JSONArray();
        double totalDistance = 0.0;
        double totalDuration = 0.0;

        for (int g = 0; g < geoJsons.size(); g++) {
            JSONObject feature = geoJsons.get(g).getJSONArray("features").getJSONObject(0);
            JSONObject props = feature.getJSONObject("properties");
            JSONArray rawCoords = feature.getJSONObject("geometry").getJSONArray("coordinates");
            JSONArray voiceHints = props.optJSONArray("voicehints");

            totalDistance += props.optDouble("track-length", 0.0);
            totalDuration += props.optDouble("total-time", 0.0);

            int baseOffset = combinedCoords.length();
            int startIdx = (g > 0 && rawCoords.length() > 1) ? 1 : 0;
            for (int i = startIdx; i < rawCoords.length(); i++) {
                combinedCoords.put(rawCoords.getJSONArray(i));
            }
            if (voiceHints != null) {
                for (int i = 0; i < voiceHints.length(); i++) {
                    JSONArray vh = voiceHints.getJSONArray(i);
                    int localIdx = vh.optInt(0, 0);
                    int mappedIdx = baseOffset + Math.max(0, localIdx - startIdx);
                    JSONArray shifted = new JSONArray();
                    shifted.put(mappedIdx);
                    for (int k = 1; k < vh.length(); k++) shifted.put(vh.get(k));
                    combinedVoiceHints.put(shifted);
                }
            }
        }

        JSONObject mergedProps = new JSONObject();
        mergedProps.put("track-length", totalDistance);
        mergedProps.put("total-time", totalDuration);
        mergedProps.put("voicehints", combinedVoiceHints);

        JSONObject mergedGeom = new JSONObject();
        mergedGeom.put("type", "LineString");
        mergedGeom.put("coordinates", combinedCoords);

        JSONObject mergedFeature = new JSONObject();
        mergedFeature.put("type", "Feature");
        mergedFeature.put("properties", mergedProps);
        mergedFeature.put("geometry", mergedGeom);

        JSONArray features = new JSONArray();
        features.put(mergedFeature);
        JSONObject mergedGeoJson = new JSONObject();
        mergedGeoJson.put("type", "FeatureCollection");
        mergedGeoJson.put("features", features);

        return convertGeoJsonToRouteWeather(mergedGeoJson, requestedCoords, truck, elapsedMs);
    }

    static JSONObject convertGeoJsonToRouteWeather(JSONObject geoJson, List<double[]> requestedCoords,
                                                   boolean truck, long elapsedMs) throws JSONException {
        JSONArray features = geoJson.getJSONArray("features");
        JSONObject feature = features.getJSONObject(0);
        JSONObject props = feature.getJSONObject("properties");
        JSONArray rawCoords = feature.getJSONObject("geometry").getJSONArray("coordinates");

        double totalDistance = props.optDouble("track-length", 0.0);
        double totalDuration = props.optDouble("total-time", 0.0);

        // Normalize coordinates to [lon, lat] and compute cumulative distances
        JSONArray geometryCoords = new JSONArray();
        double[] cumulativeMeters = new double[rawCoords.length()];
        double prevLon = 0, prevLat = 0;
        for (int i = 0; i < rawCoords.length(); i++) {
            JSONArray pt = rawCoords.getJSONArray(i);
            double lon = pt.getDouble(0);
            double lat = pt.getDouble(1);
            JSONArray pair = new JSONArray();
            pair.put(lon);
            pair.put(lat);
            geometryCoords.put(pair);
            if (i > 0) {
                cumulativeMeters[i] = cumulativeMeters[i - 1]
                        + OfflineSearchStore.haversineMeters(prevLat, prevLon, lat, lon);
            }
            prevLon = lon;
            prevLat = lat;
        }
        double geomTotal = cumulativeMeters.length > 0 ? cumulativeMeters[cumulativeMeters.length - 1] : 0.0;
        if (totalDistance <= 0 && geomTotal > 0) totalDistance = geomTotal;
        // OsmPathModel uses bicycle-speed defaults (~28 mph); normalize highway/car/truck travel time
        if (totalDistance > 0 && (totalDuration <= 0 || (totalDistance > 10_000 && (totalDistance / totalDuration) < 16.0))) {
            double avgSpeedMs = totalDistance > 80_000
                    ? (truck ? 23.7 : 26.8)  // ~53 mph truck, ~60 mph car on long highway routes
                    : (truck ? 18.3 : 20.1); // ~41 mph truck, ~45 mph car on shorter regional routes
            totalDuration = totalDistance / avgSpeedMs;
        }

        // Parse per-segment durations for Route Weather's weather sampling annotation
        JSONArray segDurations = new JSONArray();
        for (int i = 1; i < cumulativeMeters.length; i++) {
            double segLen = cumulativeMeters[i] - cumulativeMeters[i - 1];
            double segDur = geomTotal > 0 ? (segLen / geomTotal) * totalDuration : 0.0;
            segDurations.put(segDur);
        }

        // Convert BRouter voicehints into Route Weather steps
        JSONArray steps = new JSONArray();
        JSONArray voiceHints = props.optJSONArray("voicehints");
        if (voiceHints != null) {
            for (int i = 0; i < voiceHints.length(); i++) {
                JSONArray vh = voiceHints.getJSONArray(i);
                int trackIdx = Math.max(0, Math.min(rawCoords.length() - 1, vh.optInt(0, 0)));
                int cmdCode = vh.optInt(1, 0);
                double stepDist = vh.optDouble(3, 0.0);
                String[] mapped = mapVoiceHint(cmdCode);
                if (mapped == null) continue;

                JSONArray pt = geometryCoords.getJSONArray(trackIdx);
                JSONObject maneuver = new JSONObject();
                maneuver.put("type", mapped[0]);
                maneuver.put("location", pt);

                JSONObject step = new JSONObject();
                step.put("instruction", mapped[1]);
                step.put("offset", Math.round(cumulativeMeters[trackIdx]));
                step.put("name", "");
                step.put("distance", Math.round(stepDist));
                step.put("maneuver", maneuver);
                steps.put(step);
            }
        }

        // Always append ARRIVE step at the destination
        if (geometryCoords.length() > 0) {
            JSONObject arriveManeuver = new JSONObject();
            arriveManeuver.put("type", "ARRIVE");
            arriveManeuver.put("location", geometryCoords.getJSONArray(geometryCoords.length() - 1));
            JSONObject arriveStep = new JSONObject();
            arriveStep.put("instruction", "You have arrived at your destination.");
            arriveStep.put("offset", Math.round(totalDistance));
            arriveStep.put("name", "");
            arriveStep.put("distance", 0);
            arriveStep.put("maneuver", arriveManeuver);
            steps.put(arriveStep);
        }

        JSONObject leg = new JSONObject();
        leg.put("distance", Math.round(totalDistance));
        leg.put("duration", Math.round(totalDuration));
        leg.put("steps", steps);
        JSONObject annotation = new JSONObject();
        annotation.put("duration", segDurations);
        leg.put("annotation", annotation);

        JSONArray legs = new JSONArray();
        legs.put(leg);

        JSONObject geomObj = new JSONObject();
        geomObj.put("type", "LineString");
        geomObj.put("coordinates", geometryCoords);

        JSONObject routeObj = new JSONObject();
        routeObj.put("distance", Math.round(totalDistance));
        routeObj.put("duration", Math.round(totalDuration));
        routeObj.put("geometry", geomObj);
        routeObj.put("legs", legs);

        JSONArray routes = new JSONArray();
        routes.put(routeObj);

        JSONArray matchedWaypoints = new JSONArray();
        for (int i = 0; i < requestedCoords.size(); i++) {
            JSONObject wp = new JSONObject();
            JSONArray loc = new JSONArray();
            if (i == 0) {
                loc = geometryCoords.getJSONArray(0);
            } else if (i == requestedCoords.size() - 1) {
                loc = geometryCoords.getJSONArray(geometryCoords.length() - 1);
            } else {
                loc.put(requestedCoords.get(i)[0]);
                loc.put(requestedCoords.get(i)[1]);
            }
            wp.put("location", loc);
            matchedWaypoints.put(wp);
        }

        JSONObject response = new JSONObject();
        response.put("code", "Ok");
        response.put("provider", "offline-brouter");
        response.put("profile", truck ? "truck" : "car");
        response.put("calculationMs", elapsedMs);
        if (truck) {
            response.put("truckDisclaimer", TRUCK_DISCLAIMER);
        }
        response.put("waypoints", matchedWaypoints);
        response.put("routes", routes);
        return response;
    }

    /**
     * Maps BRouter VoiceHint command codes to [maneuverType, spokenInstruction].
     */
    private static String[] mapVoiceHint(int cmd) {
        switch (cmd) {
            case 1:  return new String[]{"CONTINUE", "Continue straight"};
            case 2:  return new String[]{"TURN_LEFT", "Turn left"};
            case 3:  return new String[]{"BEAR_LEFT", "Bear left"};
            case 4:  return new String[]{"SHARP_LEFT", "Make a sharp left"};
            case 5:  return new String[]{"TURN_RIGHT", "Turn right"};
            case 6:  return new String[]{"BEAR_RIGHT", "Bear right"};
            case 7:  return new String[]{"SHARP_RIGHT", "Make a sharp right"};
            case 8:  return new String[]{"KEEP_LEFT", "Keep left"};
            case 9:  return new String[]{"KEEP_RIGHT", "Keep right"};
            case 10: return new String[]{"MAKE_UTURN", "Make a U-turn"};
            case 11: return new String[]{"MAKE_UTURN", "Make a U-turn"};
            case 13: return new String[]{"ROUNDABOUT_RIGHT", "Enter the roundabout"};
            case 14: return new String[]{"ROUNDABOUT_LEFT", "Enter the roundabout"};
            case 15: return new String[]{"MAKE_UTURN", "Make a U-turn"};
            case 17: return new String[]{"EXIT_LEFT", "Take the exit on the left"};
            case 18: return new String[]{"EXIT_RIGHT", "Take the exit on the right"};
            default: return null;
        }
    }

    private static void copyAssetIfMissing(Context context, String assetPath, File target) {
        try (InputStream in = context.getAssets().open(assetPath);
             FileOutputStream out = new FileOutputStream(target)) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        } catch (IOException e) {
            Log.w(TAG, "Could not stage routing profile asset: " + assetPath, e);
        }
    }
}
