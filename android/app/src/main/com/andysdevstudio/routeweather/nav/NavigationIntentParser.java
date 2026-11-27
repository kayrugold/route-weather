package com.andysdevstudio.routeweather.nav;

import android.content.Intent;
import android.net.Uri;

import org.json.JSONObject;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Parses Google Assistant / Gemini Android Navigation Interoperability Intents:
 *  - android.intent.action.NAVIGATE with geo: / geo.offline:
 *  - android.intent.action.VIEW with geo: (search) and google.navigation:
 *  - android.intent.action.VIEW with geo.action: (mute, unmute, exit_navigation, avoid_*, etc.)
 *  - App Actions / shortcuts.xml extras (atlas_action, atlas_feature, atlas_destination)
 */
public final class NavigationIntentParser {
    public static final String ACTION_NAVIGATE = "android.intent.action.NAVIGATE";

    private NavigationIntentParser() {}

    public static JSONObject parse(Intent intent) {
        if (intent == null) return null;
        try {
            // 1. Explicit App Actions / shortcut extras
            String explicitAction = intent.getStringExtra("atlas_action");
            String explicitValue = intent.getStringExtra("atlas_value");
            String feature = intent.getStringExtra("atlas_feature");
            String explicitDest = intent.getStringExtra("atlas_destination");

            if (notEmpty(explicitAction)) {
                return new JSONObject()
                    .put("action", explicitAction.trim())
                    .put("value", explicitValue == null ? "" : explicitValue.trim());
            }
            if (notEmpty(explicitDest)) {
                return new JSONObject()
                    .put("action", "navigate_intent")
                    .put("destination", explicitDest.trim());
            }
            if (notEmpty(feature)) {
                return new JSONObject()
                    .put("action", "feature")
                    .put("value", feature.trim());
            }

            String intentAction = intent.getAction();
            Uri data = intent.getData();
            if (data == null || intentAction == null) return null;

            String scheme = data.getScheme() == null ? "" : data.getScheme().toLowerCase(Locale.ROOT);
            String ssp = data.getSchemeSpecificPart();
            Map<String, String> params = parseOpaqueQueryParams(ssp);

            // 2. Runtime custom actions: geo.action:?act=...
            if ("geo.action".equals(scheme)) {
                String act = firstNonEmpty(params.get("act"), params.get("action"));
                if (!notEmpty(act)) return null;
                return mapGeoAction(act.trim().toLowerCase(Locale.ROOT), params);
            }

            // 3. Navigation & geo search intents:
            //    android.intent.action.NAVIGATE (geo: / geo.offline:)
            //    android.intent.action.VIEW (geo: / google.navigation:)
            boolean isNavigate = ACTION_NAVIGATE.equals(intentAction)
                || "google.navigation".equals(scheme)
                || "geo.offline".equals(scheme);
            boolean isGeoView = Intent.ACTION_VIEW.equals(intentAction) && "geo".equals(scheme);

            if (!isNavigate && !isGeoView) return null;

            String query = params.get("q");
            String coordsPart = ssp == null ? "" : ssp.split("\\?", 2)[0].trim();
            double lat = Double.NaN;
            double lon = Double.NaN;
            if (coordsPart.contains(",")) {
                String[] parts = coordsPart.split(",");
                if (parts.length >= 2) {
                    try {
                        double pLat = Double.parseDouble(parts[0].trim());
                        double pLon = Double.parseDouble(parts[1].trim());
                        if (Math.abs(pLat) <= 90 && Math.abs(pLon) <= 180 && !(pLat == 0.0 && pLon == 0.0)) {
                            lat = pLat;
                            lon = pLon;
                        }
                    } catch (NumberFormatException ignored) {}
                }
            }

            String destination = notEmpty(query) ? query.trim()
                : (Double.isFinite(lat) && Double.isFinite(lon)
                    ? String.format(Locale.US, "%.5f, %.5f", lat, lon) : "");

            // Handle "lat,lon(Label)" syntax in ?q=
            if (destination.matches("^-?\\d+(?:\\.\\d+)?,-?\\d+(?:\\.\\d+)?\\(.+\\)$")) {
                int paren = destination.indexOf('(');
                String label = destination.substring(paren + 1, destination.length() - 1).trim();
                if (notEmpty(label)) destination = label;
            }

            if (!notEmpty(destination)) return null;

            String intentParam = params.get("intent");
            boolean addStop = "add_a_stop".equalsIgnoreCase(intentParam) || "add_stop".equalsIgnoreCase(intentParam);
            String waypoint = firstNonEmpty(params.get("waypoints"), params.get("via"));
            String avoidRaw = params.get("avoid");
            String mode = params.get("mode");

            JSONObject avoid = new JSONObject();
            if (notEmpty(avoidRaw)) {
                String a = avoidRaw.toLowerCase(Locale.ROOT);
                avoid.put("tolls", a.contains("t") || a.contains("toll"));
                avoid.put("highways", a.contains("h") || a.contains("highway"));
                avoid.put("ferries", a.contains("f") || a.contains("ferry"));
            }

            JSONObject out = new JSONObject()
                .put("action", isNavigate ? "navigate_intent" : "geo_search")
                .put("destination", destination)
                .put("addStop", addStop)
                .put("avoid", avoid);
            if (Double.isFinite(lat) && Double.isFinite(lon)) {
                out.put("lat", lat).put("lon", lon);
            }
            if (notEmpty(waypoint)) out.put("waypoint", waypoint.trim());
            if (notEmpty(mode)) out.put("mode", mode.trim().toLowerCase(Locale.ROOT));
            return out;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static JSONObject mapGeoAction(String act, Map<String, String> params) throws Exception {
        switch (act) {
            case "exit_navigation":
            case "stop_navigation":
            case "cancel_navigation":
                return new JSONObject().put("action", "clear_route").put("value", "");
            case "mute":
            case "mute_voice":
                return new JSONObject().put("action", "voice_off").put("value", "");
            case "unmute":
            case "unmute_voice":
                return new JSONObject().put("action", "voice_on").put("value", "");
            case "route_overview":
            case "show_route_overview":
                return new JSONObject().put("action", "route_overview").put("value", "");
            case "show_alternates":
            case "alternate_routes":
                return new JSONObject().put("action", "show_alternates").put("value", "");
            case "avoid_tolls":
                return new JSONObject().put("action", "route_preference").put("value", "avoid_tolls");
            case "allow_tolls":
                return new JSONObject().put("action", "route_preference").put("value", "allow_tolls");
            case "avoid_highways":
                return new JSONObject().put("action", "route_preference").put("value", "avoid_highways");
            case "allow_highways":
                return new JSONObject().put("action", "route_preference").put("value", "allow_highways");
            case "avoid_ferries":
                return new JSONObject().put("action", "route_preference").put("value", "avoid_ferries");
            case "allow_ferries":
                return new JSONObject().put("action", "route_preference").put("value", "allow_ferries");
            default:
                return new JSONObject()
                    .put("action", "geo_action_unsupported")
                    .put("value", act);
        }
    }

    private static Map<String, String> parseOpaqueQueryParams(String ssp) {
        Map<String, String> map = new HashMap<>();
        if (ssp == null) return map;
        int qIdx = ssp.indexOf('?');
        if (qIdx < 0 || qIdx + 1 >= ssp.length()) return map;
        String query = ssp.substring(qIdx + 1);
        for (String pair : query.split("&")) {
            if (pair.isEmpty()) continue;
            int eq = pair.indexOf('=');
            String rawKey = eq >= 0 ? pair.substring(0, eq) : pair;
            String rawVal = eq >= 0 ? pair.substring(eq + 1) : "";
            try {
                String k = URLDecoder.decode(rawKey, StandardCharsets.UTF_8.name()).trim().toLowerCase(Locale.ROOT);
                String v = URLDecoder.decode(rawVal, StandardCharsets.UTF_8.name()).trim();
                if (!k.isEmpty()) map.put(k, v);
            } catch (Exception ignored) {}
        }
        return map;
    }

    private static boolean notEmpty(String s) {
        return s != null && !s.trim().isEmpty();
    }

    private static String firstNonEmpty(String a, String b) {
        return notEmpty(a) ? a : (notEmpty(b) ? b : null);
    }
}
