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
import java.util.HashMap;
import java.util.List;
import java.util.Map;

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

    public OfflineRouter(Context context, File segmentsDir) {
        this.segmentsDir = segmentsDir;
        this.profilesDir = new File(context.getCacheDir(), "offline-profiles");
        this.profilesDir.mkdirs();
        copyAssetIfMissing(context, "offline-profiles/lookups.dat", new File(profilesDir, "lookups.dat"));
        copyAssetIfMissing(context, "offline-profiles/car-fast.brf", new File(profilesDir, "car-fast.brf"));
        copyAssetIfMissing(context, "offline-profiles/truck.brf", new File(profilesDir, "truck.brf"));
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

        List<OsmNodeNamed> waypoints = new ArrayList<>(coords.size());
        for (int i = 0; i < coords.size(); i++) {
            double lon = coords.get(i)[0];
            double lat = coords.get(i)[1];
            OsmNodeNamed wp = new OsmNodeNamed();
            wp.name = i == 0 ? "from" : (i == coords.size() - 1 ? "to" : "via" + i);
            wp.ilon = (int) Math.round((lon + 180.0) * 1_000_000.0);
            wp.ilat = (int) Math.round((lat + 90.0) * 1_000_000.0);
            waypoints.add(wp);
        }

        RoutingContext rc = new RoutingContext();
        rc.localFunction = profileFile.getAbsolutePath();
        rc.carMode = true;
        rc.considerTurnRestrictions = true;
        rc.memoryclass = 64;
        rc.keyValues = new HashMap<>();
        rc.keyValues.put("turnInstructionMode", "3");

        long started = System.currentTimeMillis();
        RoutingEngine engine = new RoutingEngine(null, null, segmentsDir, waypoints, rc);
        engine.quite = true;
        engine.doRun(30_000L);
        long elapsedMs = System.currentTimeMillis() - started;

        String err = engine.getErrorMessage();
        OsmTrack track = engine.getFoundTrack();
        if (track == null || track.nodes == null || track.nodes.size() < 2) {
            throw new IllegalStateException(err != null && !err.isEmpty()
                    ? "Offline routing failed: " + err
                    : "No offline road route found. Check that map packages cover the entire trip.");
        }

        String geoJsonStr = new FormatJson(rc).format(track);
        JSONObject result = convertGeoJsonToRouteWeather(new JSONObject(geoJsonStr), coords, truck, elapsedMs);
        Log.i(TAG, "Offline route calculated (" + (truck ? "truck" : "car") + ") in " + elapsedMs + " ms");
        return result;
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
        if (totalDuration <= 0 && totalDistance > 0) {
            // Fallback estimate (~55 mph car, ~50 mph truck)
            totalDuration = totalDistance / (truck ? 22.3 : 24.6);
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
        if (target.isFile() && target.length() > 0) return;
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
