package com.andysdevstudio.routeweather.offline;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.DataOutputStream;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Facade coordinating offline vector tiles (.pmtiles), offline routing (.rd5 via BRouter),
 * offline search (-search.db via SQLite FTS5), and R2 package management.
 */
public final class OfflineEngine implements Closeable {
    private static final String TAG = "RouteWeatherOffline";

    private final OfflinePackageManager packageManager;
    private final OfflineSearchStore searchStore;
    private final OfflineRouter router;
    private final CopyOnWriteArrayList<PMTilesReader> tileReaders = new CopyOnWriteArrayList<>();

    public OfflineEngine(Context context, OfflinePackageManager.Listener externalListener) {
        this.searchStore = new OfflineSearchStore();
        this.packageManager = new OfflinePackageManager(context, new OfflinePackageManager.Listener() {
            @Override
            public void onProgress(String packageId, String state, long downloadedBytes, long totalBytes, String message) {
                if (externalListener != null) {
                    externalListener.onProgress(packageId, state, downloadedBytes, totalBytes, message);
                }
            }

            @Override
            public void onInstalledChanged() {
                reloadInstalledData();
                if (externalListener != null) externalListener.onInstalledChanged();
            }
        });
        this.router = new OfflineRouter(context, packageManager.getRoutingDir());
        reloadInstalledData();
    }

    public synchronized void reloadInstalledData() {
        closeTileReaders();
        for (File f : packageManager.listValidTileFiles()) {
            try {
                tileReaders.add(new PMTilesReader(f));
            } catch (IOException e) {
                Log.w(TAG, "Skipping unreadable PMTiles archive: " + f.getName(), e);
            }
        }
        searchStore.reload(packageManager.listValidSearchFiles());
        Log.i(TAG, "Reloaded offline engine: " + tileReaders.size() + " PMTiles, "
                + packageManager.listValidRoutingFiles().size() + " RD5 segments, "
                + packageManager.listValidSearchFiles().size() + " search DBs.");
    }

    public OfflinePackageManager getPackageManager() {
        return packageManager;
    }

    public boolean isReady() {
        return !tileReaders.isEmpty() || router.hasSegments() || searchStore.hasDatabases();
    }

    public boolean hasTiles() { return !tileReaders.isEmpty(); }
    public boolean hasRouting() { return router.hasSegments(); }
    public boolean hasSearch() { return searchStore.hasDatabases(); }

    public byte[] getVectorTile(int z, int x, int y) {
        List<byte[]> matches = new ArrayList<>();
        byte[] best = null;
        for (PMTilesReader reader : tileReaders) {
            try {
                byte[] tile = reader.getTile(z, x, y);
                if (tile != null && tile.length > 0) {
                    if (best == null || tile.length > best.length) best = tile;
                    if (z <= 7) matches.add(tile);
                }
            } catch (IOException e) {
                Log.w(TAG, "Error reading tile " + z + "/" + x + "/" + y + " from " + reader.file.getName(), e);
            }
        }
        // At continent/regional zoom (z <= 7), a single tile spans multiple regional archives.
        // Pack all matching regional MVT payloads with a tiny "RWMT" header so all regions render seamlessly.
        if (z <= 7 && matches.size() > 1) {
            try {
                ByteArrayOutputStream baos = new ByteArrayOutputStream();
                DataOutputStream dos = new DataOutputStream(baos);
                dos.writeBytes("RWMT");
                dos.writeInt(matches.size());
                for (byte[] m : matches) {
                    dos.writeInt(m.length);
                    dos.write(m);
                }
                dos.flush();
                return baos.toByteArray();
            } catch (IOException ignored) {}
        }
        return best;
    }

    public String searchJson(String query, String mode, Double lat, Double lon, int limit) {
        JSONArray results = searchStore.search(query, mode, lat, lon, limit);
        return results.toString();
    }

    public String facilitiesJson(String kind, double west, double south, double east, double north, int offset) {
        return searchStore.searchFacilities(kind, west, south, east, north, offset).toString();
    }

    public String nearestRoadJson(double lat, double lon) {
        return searchStore.nearestRoad(lat, lon).toString();
    }

    public String corridorsJson(String coordsParam) {
        try {
            String[] pairs = coordsParam.split(";");
            if (pairs.length != 2) return "[]";
            String[] a = pairs[0].split(","), b = pairs[1].split(",");
            double[] from = {Double.parseDouble(a[0].trim()), Double.parseDouble(a[1].trim())};
            double[] to = {Double.parseDouble(b[0].trim()), Double.parseDouble(b[1].trim())};
            List<InterstateCorridorPlanner.CorridorOption> opts =
                    InterstateCorridorPlanner.planAlternativeCorridors(from, to, null, 3);
            JSONArray arr = new JSONArray();
            for (InterstateCorridorPlanner.CorridorOption opt : opts) {
                JSONObject obj = new JSONObject();
                obj.put("summary", opt.label);
                obj.put("distance", Math.round(opt.estimatedMeters));
                obj.put("duration", Math.round(opt.estimatedMeters / 26.8));
                if (opt.waypoints.size() > 2) {
                    double[] mid = opt.waypoints.get(opt.waypoints.size() / 2);
                    JSONArray via = new JSONArray();
                    via.put(mid[0]);
                    via.put(mid[1]);
                    obj.put("viaAnchor", via);
                }
                JSONArray coords = new JSONArray();
                for (double[] pt : opt.waypoints) {
                    JSONArray pair = new JSONArray();
                    pair.put(pt[0]);
                    pair.put(pt[1]);
                    coords.put(pair);
                }
                JSONObject geom = new JSONObject();
                geom.put("type", "LineString");
                geom.put("coordinates", coords);
                obj.put("geometry", geom);
                arr.put(obj);
            }
            return arr.toString();
        } catch (Exception e) {
            return "[]";
        }
    }

    public String routeJson(String coordsParam, String profile) {
        try {
            String[] pairs = coordsParam.split(";");
            List<double[]> points = new ArrayList<>(pairs.length);
            for (String pair : pairs) {
                String[] xy = pair.split(",");
                if (xy.length != 2) throw new IllegalArgumentException("Invalid coordinate pair: " + pair);
                points.add(new double[]{Double.parseDouble(xy[0].trim()), Double.parseDouble(xy[1].trim())});
            }
            JSONObject route = router.calculateRoute(points, profile);
            return route.toString();
        } catch (Exception e) {
            JSONObject err = new JSONObject();
            try {
                err.put("error", e.getMessage() != null ? e.getMessage() : "Offline route calculation failed.");
            } catch (JSONException ignored) {}
            return err.toString();
        }
    }

    public String statusJson() {
        JSONObject status = packageManager.getStatusJson();
        int maxTileZoom = 14;
        if (!tileReaders.isEmpty()) {
            maxTileZoom = 0;
            for (PMTilesReader r : tileReaders) {
                if (r.maxZoom > maxTileZoom) maxTileZoom = r.maxZoom;
            }
        }
        try {
            status.put("hasTiles", hasTiles());
            status.put("hasRouting", hasRouting());
            status.put("hasSearch", hasSearch());
            status.put("maxTileZoom", maxTileZoom);
        } catch (JSONException ignored) {}
        return status.toString();
    }

    private void closeTileReaders() {
        for (PMTilesReader r : tileReaders) {
            try { r.close(); } catch (IOException ignored) {}
        }
        tileReaders.clear();
    }

    @Override
    public void close() {
        packageManager.shutdown();
        closeTileReaders();
        searchStore.close();
    }
}
