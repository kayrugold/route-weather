package com.andysdevstudio.routeweather.offline;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.Closeable;
import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/**
 * Offline SQLite FTS5 search engine for Route Weather.
 * Queries one or more installed regional *-search.db databases for cities, streets,
 * addresses, fuel stations, truck stops, weigh stations, rest areas, hospitals, and lodging.
 */
public final class OfflineSearchStore implements Closeable {
    private static final String TAG = "RouteWeatherSearch";
    private final List<SQLiteDatabase> databases = new ArrayList<>();

    public synchronized void reload(List<File> dbFiles) {
        close();
        for (File file : dbFiles) {
            if (!file.isFile() || !file.canRead()) continue;
            try {
                SQLiteDatabase db = SQLiteDatabase.openDatabase(
                        file.getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY);
                databases.add(db);
            } catch (Exception e) {
                Log.w(TAG, "Skipping unreadable search database: " + file.getName(), e);
            }
        }
    }

    public synchronized boolean hasDatabases() {
        return !databases.isEmpty();
    }

    /**
     * Text search matching Route Weather's /api/search JSON array format:
     * [{lat, lon, display_name, category, type, addresstype, distance?}]
     */
    public synchronized JSONArray search(String rawQuery, String mode, Double nearLat, Double nearLon, int limit) {
        List<Candidate> all = new ArrayList<>();
        if (databases.isEmpty()) return new JSONArray();

        if ("truck-stops".equals(mode) && nearLat != null && nearLon != null) {
            double latDelta = 0.55; // ~60 km
            double lonDelta = 0.70;
            for (SQLiteDatabase db : databases) {
                queryNearbyCategory(db, "truck_stop", nearLat, nearLon, latDelta, lonDelta, all);
            }
            Collections.sort(all, Comparator.comparingDouble(c -> c.distanceMeters));
        } else {
            String ftsQuery = buildFtsQuery(rawQuery);
            if (ftsQuery.isEmpty()) return new JSONArray();
            for (SQLiteDatabase db : databases) {
                queryFts(db, ftsQuery, mode, nearLat, nearLon, all);
            }
            Collections.sort(all, (a, b) -> {
                int scoreCmp = Double.compare(b.score, a.score);
                if (scoreCmp != 0) return scoreCmp;
                return Double.compare(a.distanceMeters, b.distanceMeters);
            });
        }

        JSONArray out = new JSONArray();
        int cap = Math.max(1, Math.min(limit, 20));
        for (int i = 0; i < Math.min(cap, all.size()); i++) {
            Candidate c = all.get(i);
            try {
                JSONObject item = new JSONObject();
                item.put("lat", c.lat);
                item.put("lon", c.lon);
                item.put("display_name", c.name);
                item.put("category", "place".equals(c.category) ? "place" : c.category);
                item.put("type", c.subtitle);
                item.put("addresstype", c.subtitle);
                if (Double.isFinite(c.distanceMeters)) {
                    item.put("distance", Math.round(c.distanceMeters));
                }
                out.put(item);
            } catch (JSONException ignored) {}
        }
        return out;
    }

    /**
     * Bounding-box facility query matching /api/search?mode=facilities&kind=truck-stops|weigh-stations
     */
    public synchronized JSONObject searchFacilities(String kind, double west, double south, double east, double north, int offset) {
        String category = "weigh-stations".equals(kind) ? "weigh_station" : "truck_stop";
        JSONArray items = new JSONArray();
        int total = 0;
        for (SQLiteDatabase db : databases) {
            try (Cursor cursor = db.rawQuery(
                    "SELECT id, name, brand, subtitle, lat, lon FROM places "
                            + "WHERE category = ? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? "
                            + "ORDER BY rank DESC LIMIT 100 OFFSET ?",
                    new String[]{category, String.valueOf(south), String.valueOf(north),
                            String.valueOf(west), String.valueOf(east), String.valueOf(Math.max(0, offset))})) {
                while (cursor.moveToNext()) {
                    JSONObject obj = new JSONObject();
                    obj.put("id", "offline-" + cursor.getLong(0));
                    obj.put("name", cursor.getString(1));
                    obj.put("brand", cursor.isNull(2) ? "" : cursor.getString(2));
                    obj.put("address", cursor.isNull(3) ? "" : cursor.getString(3));
                    obj.put("lat", cursor.getDouble(4));
                    obj.put("lon", cursor.getDouble(5));
                    items.put(obj);
                    total++;
                }
            } catch (Exception e) {
                Log.w(TAG, "Facility search error", e);
            }
        }
        JSONObject result = new JSONObject();
        try {
            result.put("items", items);
            result.put("total", total);
            result.put("offset", offset);
        } catch (JSONException ignored) {}
        return result;
    }

    private void queryNearbyCategory(SQLiteDatabase db, String category, double lat, double lon,
                                     double latDelta, double lonDelta, List<Candidate> out) {
        try (Cursor cursor = db.rawQuery(
                "SELECT name, subtitle, category, lat, lon, rank FROM places "
                        + "WHERE category = ? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? LIMIT 60",
                new String[]{category, String.valueOf(lat - latDelta), String.valueOf(lat + latDelta),
                        String.valueOf(lon - lonDelta), String.valueOf(lon + lonDelta)})) {
            while (cursor.moveToNext()) {
                double cLat = cursor.getDouble(3);
                double cLon = cursor.getDouble(4);
                double dist = haversineMeters(lat, lon, cLat, cLon);
                if (dist <= 65000.0) {
                    out.add(new Candidate(cursor.getString(0), cursor.getString(1), cursor.getString(2),
                            cLat, cLon, cursor.getInt(5), dist, 1000.0 - dist / 100.0));
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Nearby category query failed", e);
        }
    }

    private void queryFts(SQLiteDatabase db, String ftsQuery, String mode,
                          Double nearLat, Double nearLon, List<Candidate> out) {
        String sql = "SELECT p.name, p.subtitle, p.category, p.lat, p.lon, p.rank, bm25(places_fts) AS relevance "
                + "FROM places_fts JOIN places p ON p.id = places_fts.rowid "
                + "WHERE places_fts MATCH ? "
                + "ORDER BY relevance ASC, p.rank DESC LIMIT 25";
        try (Cursor cursor = db.rawQuery(sql, new String[]{ftsQuery})) {
            while (cursor.moveToNext()) {
                String name = cursor.getString(0);
                String subtitle = cursor.getString(1);
                String category = cursor.getString(2);
                double cLat = cursor.getDouble(3);
                double cLon = cursor.getDouble(4);
                int rank = cursor.getInt(5);
                double bm25 = cursor.getDouble(6);
                double dist = (nearLat != null && nearLon != null)
                        ? haversineMeters(nearLat, nearLon, cLat, cLon) : Double.NaN;
                double score = -bm25 * 10.0 + rank * 0.5;
                if ("place".equals(category)) score += 15.0;
                if ("places".equals(mode) && Double.isFinite(dist)) {
                    score += Math.max(0.0, 20.0 - dist / 5000.0);
                }
                out.add(new Candidate(name, subtitle, category, cLat, cLon, rank, dist, score));
            }
        } catch (Exception e) {
            Log.w(TAG, "FTS query failed for: " + ftsQuery, e);
        }
    }

    static String buildFtsQuery(String raw) {
        if (raw == null) return "";
        String cleaned = raw.trim().toLowerCase(Locale.US).replaceAll("[^a-z0-9\\s]", " ");
        String[] tokens = cleaned.split("\\s+");
        StringBuilder sb = new StringBuilder();
        for (String token : tokens) {
            if (token.isEmpty()) continue;
            if (sb.length() > 0) sb.append(' ');
            sb.append(token).append('*');
        }
        return sb.toString();
    }

    static double haversineMeters(double lat1, double lon1, double lat2, double lon2) {
        double dLat = Math.toRadians(lat2 - lat1);
        double dLon = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
                * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 12742000.0 * Math.asin(Math.sqrt(Math.min(1.0, a)));
    }

    @Override
    public synchronized void close() {
        for (SQLiteDatabase db : databases) {
            try { db.close(); } catch (Exception ignored) {}
        }
        databases.clear();
    }

    private static final class Candidate {
        final String name;
        final String subtitle;
        final String category;
        final double lat;
        final double lon;
        final int rank;
        final double distanceMeters;
        final double score;

        Candidate(String name, String subtitle, String category, double lat, double lon,
                  int rank, double distanceMeters, double score) {
            this.name = name;
            this.subtitle = subtitle;
            this.category = category;
            this.lat = lat;
            this.lon = lon;
            this.rank = rank;
            this.distanceMeters = distanceMeters;
            this.score = score;
        }
    }
}
