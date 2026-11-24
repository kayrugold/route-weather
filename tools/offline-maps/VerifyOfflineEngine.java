import com.andysdevstudio.routeweather.offline.PMTilesReader;
import btools.router.FormatJson;
import btools.router.OsmNodeNamed;
import btools.router.OsmTrack;
import btools.router.RoutingContext;
import btools.router.RoutingEngine;

import java.io.File;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;

/**
 * End-to-end JVM verification harness for Route Weather's offline engine:
 * 1. Verifies PMTilesReader reads real MVT vector tiles for Anderson, CA and Stockton, CA.
 * 2. Verifies BRouter routing Anderson, CA -> Stockton, CA for both Car and Truck profiles.
 */
public final class VerifyOfflineEngine {
    // Primary real-world test route: Anderson, CA -> Stockton, CA
    private static final double ANDERSON_LAT = 40.4482;
    private static final double ANDERSON_LON = -122.2978;
    private static final double STOCKTON_LAT = 37.9577;
    private static final double STOCKTON_LON = -121.2908;

    public static void main(String[] args) throws Exception {
        if (args.length < 3) {
            System.err.println("Usage: VerifyOfflineEngine <norcal.pmtiles> <segmentsDir> <profilesDir>");
            System.exit(1);
        }
        File pmtilesFile = new File(args[0]);
        File segmentsDir = new File(args[1]);
        File profilesDir = new File(args[2]);

        // 1. Verify PMTilesReader
        System.out.println("=== 1. PMTilesReader Verification ===");
        try (PMTilesReader reader = new PMTilesReader(pmtilesFile)) {
            System.out.printf(Locale.US, "PMTiles header: z%d..z%d bbox=[%.4f, %.4f, %.4f, %.4f] size=%.2f MB%n",
                    reader.minZoom, reader.maxZoom, reader.minLon, reader.minLat, reader.maxLon, reader.maxLat,
                    pmtilesFile.length() / (1024.0 * 1024.0));
            for (int z : new int[]{7, 10, 12, 14}) {
                int[] aTile = latLonToTile(ANDERSON_LAT, ANDERSON_LON, z);
                int[] sTile = latLonToTile(STOCKTON_LAT, STOCKTON_LON, z);
                byte[] aBytes = reader.getTile(z, aTile[0], aTile[1]);
                byte[] sBytes = reader.getTile(z, sTile[0], sTile[1]);
                System.out.printf(Locale.US, "  z%2d: Anderson (%d/%d) = %s | Stockton (%d/%d) = %s%n",
                        z, aTile[0], aTile[1], aBytes != null ? aBytes.length + " B" : "MISSING",
                        sTile[0], sTile[1], sBytes != null ? sBytes.length + " B" : "MISSING");
                if (aBytes == null || sBytes == null) {
                    throw new IllegalStateException("Expected vector tile missing at z" + z);
                }
            }
        }

        // 2. Verify BRouter Routing (Car & Truck)
        System.out.println("\n=== 2. BRouter Offline Routing Verification (Anderson, CA -> Stockton, CA) ===");
        for (String profileName : new String[]{"car-fast.brf", "truck.brf"}) {
            File profileFile = new File(profilesDir, profileName);
            List<OsmNodeNamed> wps = new ArrayList<>();
            OsmNodeNamed from = new OsmNodeNamed();
            from.name = "Anderson, CA";
            from.ilon = (int) Math.round((ANDERSON_LON + 180.0) * 1_000_000.0);
            from.ilat = (int) Math.round((ANDERSON_LAT + 90.0) * 1_000_000.0);
            wps.add(from);

            OsmNodeNamed to = new OsmNodeNamed();
            to.name = "Stockton, CA";
            to.ilon = (int) Math.round((STOCKTON_LON + 180.0) * 1_000_000.0);
            to.ilat = (int) Math.round((STOCKTON_LAT + 90.0) * 1_000_000.0);
            wps.add(to);

            RoutingContext rc = new RoutingContext();
            rc.localFunction = profileFile.getAbsolutePath();
            rc.carMode = true;
            rc.considerTurnRestrictions = true;
            rc.memoryclass = 64;
            rc.keyValues = new HashMap<>();
            rc.keyValues.put("turnInstructionMode", "3");

            long t0 = System.currentTimeMillis();
            RoutingEngine engine = new RoutingEngine(null, null, segmentsDir, wps, rc);
            engine.quite = true;
            engine.doRun(30_000L);
            long elapsed = System.currentTimeMillis() - t0;

            OsmTrack track = engine.getFoundTrack();
            if (track == null) {
                throw new IllegalStateException(profileName + " failed: " + engine.getErrorMessage());
            }
            String json = new FormatJson(rc).format(track);
            double miles = track.distance / 1609.344;
            double hours = track.getTotalSeconds() / 3600.0;
            System.out.printf(Locale.US, "  %-13s: %.1f miles, %.2f hrs (%d s), %d track points, %d ms, GeoJSON=%d KB%n",
                    profileName, miles, hours, track.getTotalSeconds(), track.nodes.size(), elapsed, json.length() / 1024);
        }
        System.out.println("\nALL OFFLINE ENGINE VERIFICATIONS PASSED.");
    }

    private static int[] latLonToTile(double lat, double lon, int z) {
        int n = 1 << z;
        int x = (int) Math.floor((lon + 180.0) / 360.0 * n);
        double latRad = Math.toRadians(lat);
        int y = (int) Math.floor((1.0 - Math.log(Math.tan(latRad) + 1.0 / Math.cos(latRad)) / Math.PI) / 2.0 * n);
        return new int[]{x, y};
    }
}
