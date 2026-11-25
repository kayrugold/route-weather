package com.andysdevstudio.routeweather.offline;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Compact North America state/province lookup (US 50 + DC, Canada 13, Mexico 32).
 * Used by OfflineSearchStore to parse state filters from user queries ("Anderson, CA",
 * "Elizabethton, TN") and enrich bare OSM city/town names with their state/province code.
 */
final class NorthAmericaRegions {
    static final class Region {
        final String code;
        final String name;
        final double minLat, maxLat, minLon, maxLon;
        final double cLat, cLon;

        Region(String code, String name, double minLat, double maxLat, double minLon, double maxLon,
               double cLat, double cLon) {
            this.code = code;
            this.name = name;
            this.minLat = minLat;
            this.maxLat = maxLat;
            this.minLon = minLon;
            this.maxLon = maxLon;
            this.cLat = cLat;
            this.cLon = cLon;
        }

        boolean contains(double lat, double lon) {
            return lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
        }
    }

    private static final Region[] REGIONS = new Region[]{
        // --- United States (50 states + DC) ---
        new Region("AL", "alabama", 30.14, 35.01, -88.47, -84.89, 32.80, -86.79),
        new Region("AK", "alaska", 51.20, 71.44, -179.15, -129.97, 64.20, -149.49),
        new Region("AZ", "arizona", 31.33, 37.00, -114.82, -109.04, 34.05, -111.09),
        new Region("AR", "arkansas", 33.00, 36.50, -94.62, -89.64, 34.97, -92.37),
        new Region("CA", "california", 32.53, 42.01, -124.48, -114.13, 36.78, -119.42),
        new Region("CO", "colorado", 36.99, 41.00, -109.06, -102.04, 39.06, -105.31),
        new Region("CT", "connecticut", 40.98, 42.05, -73.73, -71.79, 41.60, -72.76),
        new Region("DE", "delaware", 38.45, 39.84, -75.79, -75.05, 39.15, -75.51),
        new Region("DC", "district of columbia", 38.79, 39.00, -77.12, -76.91, 38.90, -77.04),
        new Region("FL", "florida", 24.40, 31.00, -87.63, -80.03, 27.77, -81.69),
        new Region("GA", "georgia", 30.36, 35.00, -85.61, -80.84, 32.68, -83.22),
        new Region("HI", "hawaii", 18.91, 22.24, -160.25, -154.81, 20.80, -156.33),
        new Region("ID", "idaho", 41.99, 49.00, -117.24, -111.04, 44.24, -114.48),
        new Region("IL", "illinois", 36.97, 42.51, -91.51, -87.02, 40.04, -89.20),
        new Region("IN", "indiana", 37.77, 41.76, -88.10, -84.78, 39.85, -86.26),
        new Region("IA", "iowa", 40.38, 43.50, -96.64, -90.14, 42.01, -93.21),
        new Region("KS", "kansas", 36.99, 40.00, -102.05, -94.59, 38.53, -96.73),
        new Region("KY", "kentucky", 36.50, 39.15, -89.57, -81.96, 37.67, -84.67),
        new Region("LA", "louisiana", 28.93, 33.02, -94.04, -88.82, 31.17, -91.87),
        new Region("ME", "maine", 43.06, 47.46, -71.08, -66.95, 45.25, -69.45),
        new Region("MD", "maryland", 37.91, 39.72, -79.49, -75.05, 39.06, -76.80),
        new Region("MA", "massachusetts", 41.24, 42.89, -73.51, -69.93, 42.23, -71.53),
        new Region("MI", "michigan", 41.70, 48.26, -90.42, -82.12, 44.18, -84.51),
        new Region("MN", "minnesota", 43.50, 49.38, -97.24, -89.49, 46.28, -94.31),
        new Region("MS", "mississippi", 30.17, 35.00, -91.66, -88.10, 32.74, -89.68),
        new Region("MO", "missouri", 35.99, 40.61, -95.77, -89.10, 38.46, -92.29),
        new Region("MT", "montana", 44.36, 49.00, -116.05, -104.04, 46.92, -110.45),
        new Region("NE", "nebraska", 40.00, 43.00, -104.05, -95.31, 41.49, -99.90),
        new Region("NV", "nevada", 35.00, 42.00, -120.01, -114.04, 38.80, -116.42),
        new Region("NH", "new hampshire", 42.70, 45.31, -72.56, -70.61, 43.45, -71.56),
        new Region("NJ", "new jersey", 38.93, 41.36, -75.56, -73.89, 40.30, -74.52),
        new Region("NM", "new mexico", 31.33, 37.00, -109.05, -103.00, 34.52, -105.87),
        new Region("NY", "new york", 40.50, 45.02, -79.76, -71.86, 42.95, -75.53),
        new Region("NC", "north carolina", 33.84, 36.59, -84.32, -75.46, 35.63, -79.81),
        new Region("ND", "north dakota", 45.94, 49.00, -104.05, -96.55, 47.53, -99.78),
        new Region("OH", "ohio", 38.40, 42.33, -84.82, -80.52, 40.39, -82.76),
        new Region("OK", "oklahoma", 33.62, 37.00, -103.00, -94.43, 35.57, -96.93),
        new Region("OR", "oregon", 41.99, 46.29, -124.57, -116.46, 43.93, -120.56),
        new Region("PA", "pennsylvania", 39.72, 42.52, -80.52, -74.69, 40.88, -77.80),
        new Region("RI", "rhode island", 41.15, 42.02, -71.86, -71.12, 41.68, -71.51),
        new Region("SC", "south carolina", 32.03, 35.22, -83.35, -78.54, 33.86, -80.95),
        new Region("SD", "south dakota", 42.48, 45.95, -104.06, -96.44, 44.30, -99.44),
        new Region("TN", "tennessee", 34.98, 36.68, -90.31, -81.65, 35.75, -86.69),
        new Region("TX", "texas", 25.84, 36.50, -106.65, -93.51, 31.48, -99.33),
        new Region("UT", "utah", 37.00, 42.00, -114.05, -109.04, 39.32, -111.09),
        new Region("VT", "vermont", 42.73, 45.02, -73.44, -71.46, 44.05, -72.71),
        new Region("VA", "virginia", 36.54, 39.47, -83.68, -75.24, 37.77, -78.17),
        new Region("WA", "washington", 45.54, 49.00, -124.76, -116.92, 47.40, -120.50),
        new Region("WV", "west virginia", 37.20, 40.64, -82.64, -77.72, 38.49, -80.95),
        new Region("WI", "wisconsin", 42.49, 47.08, -92.89, -86.25, 44.27, -89.62),
        new Region("WY", "wyoming", 40.99, 45.01, -111.06, -104.05, 42.76, -107.30),

        // --- Canada (13 provinces & territories) ---
        new Region("BC", "british columbia", 48.30, 60.00, -139.06, -114.05, 53.73, -127.65),
        new Region("AB", "alberta", 49.00, 60.00, -120.00, -110.00, 53.93, -116.58),
        new Region("SK", "saskatchewan", 49.00, 60.00, -110.00, -101.36, 52.94, -106.45),
        new Region("MB", "manitoba", 49.00, 60.00, -102.00, -88.98, 53.76, -98.81),
        new Region("ON", "ontario", 41.68, 56.86, -95.15, -74.34, 49.25, -84.74),
        new Region("QC", "quebec", 44.99, 62.58, -79.76, -57.10, 52.94, -73.55),
        new Region("NB", "new brunswick", 44.60, 48.07, -69.05, -63.77, 46.50, -66.16),
        new Region("NS", "nova scotia", 43.39, 47.03, -66.33, -59.68, 44.68, -63.74),
        new Region("PE", "prince edward island", 45.95, 47.06, -64.42, -61.97, 46.25, -63.13),
        new Region("NL", "newfoundland and labrador", 46.61, 60.38, -67.80, -52.62, 53.14, -57.66),
        new Region("YT", "yukon", 60.00, 69.65, -141.00, -123.80, 64.28, -135.00),
        new Region("NT", "northwest territories", 60.00, 78.76, -136.44, -102.00, 64.83, -124.85),
        new Region("NU", "nunavut", 51.70, 83.11, -120.68, -61.15, 70.30, -83.11),

        // --- Mexico (major states / country fallback) ---
        new Region("BCN", "baja california", 28.00, 32.72, -117.13, -112.76, 30.84, -115.28),
        new Region("BCS", "baja california sur", 22.87, 28.00, -115.08, -109.41, 26.04, -111.67),
        new Region("SON", "sonora", 26.29, 32.49, -115.05, -108.42, 29.30, -110.33),
        new Region("CHIH", "chihuahua", 25.56, 31.78, -109.07, -103.31, 28.63, -106.07),
        new Region("COAH", "coahuila", 24.54, 29.88, -103.96, -99.84, 27.06, -101.71),
        new Region("NLX", "nuevo leon", 23.16, 27.80, -101.21, -98.42, 25.59, -99.99),
        new Region("JAL", "jalisco", 18.93, 22.75, -105.69, -101.51, 20.66, -103.35),
        new Region("CDMX", "ciudad de mexico", 19.05, 19.59, -99.36, -98.94, 19.43, -99.13),
        new Region("MX", "mexico", 14.53, 32.72, -118.40, -86.71, 23.63, -102.55)
    };

    private static final Map<String, Region> BY_CODE = new HashMap<>();
    private static final Map<String, Region> BY_NAME = new HashMap<>();

    static {
        for (Region r : REGIONS) {
            BY_CODE.put(r.code.toLowerCase(Locale.US), r);
            BY_NAME.put(r.name.toLowerCase(Locale.US), r);
        }
    }

    static Region findByToken(String token) {
        if (token == null) return null;
        String norm = token.trim().toLowerCase(Locale.US).replaceAll("[^a-z\\s]", "").replaceAll("\\s+", " ").trim();
        if (norm.isEmpty()) return null;
        Region r = BY_CODE.get(norm);
        if (r != null) return r;
        return BY_NAME.get(norm);
    }

    /**
     * Checks if (lat, lon) lies within the given region's bounding box (with a small 0.12° border tolerance).
     */
    static boolean isPointInRegion(double lat, double lon, Region r) {
        if (r == null) return false;
        return lat >= r.minLat - 0.12 && lat <= r.maxLat + 0.12
                && lon >= r.minLon - 0.12 && lon <= r.maxLon + 0.12;
    }

    /**
     * Infers the most likely state/province code for a (lat, lon) coordinate using bounding-box
     * containment with nearest-centroid tie-breaking for overlapping boxes.
     */
    static String inferStateCode(double lat, double lon) {
        Region best = null;
        double bestScore = Double.POSITIVE_INFINITY;
        for (Region r : REGIONS) {
            if ("MX".equals(r.code)) continue; // keep country fallback last
            if (!r.contains(lat, lon)) continue;
            // Normalized distance to centroid inside box
            double dLat = (lat - r.cLat);
            double dLon = (lon - r.cLon) * Math.cos(Math.toRadians(lat));
            double dist2 = dLat * dLat + dLon * dLon;
            if (dist2 < bestScore) {
                bestScore = dist2;
                best = r;
            }
        }
        if (best != null) return best.code;
        if (lat >= 14.5 && lat <= 32.72 && lon >= -118.4 && lon <= -86.7) return "MX";
        return "";
    }
}
