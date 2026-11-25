package com.andysdevstudio.routeweather.offline;

import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.PriorityQueue;

/**
 * Lightweight North America Interstate / Trans-Canada / Mexican Federal Highway hub planner.
 * Breaks long-distance (> 350 mile) offline legs into ~180-280 mile highway sub-legs so BRouter
 * can route coast-to-coast across the US, Canada, and Mexico in seconds instead of timing out.
 */
final class InterstateCorridorPlanner {
    private static final double MIN_LEG_METERS = 300.0 * 1609.344;      // 300 miles
    private static final double END_TRIM_METERS = 70.0 * 1609.344;      // don't force hubs within 70 mi of ends
    private static final double MIN_HUB_SPACING_METERS = 75.0 * 1609.344; // keep hubs >= 75 mi apart (never skip key junctions)
    private static final double MAX_ATTACH_METERS = 420.0 * 1609.344;   // max distance from endpoint to nearest hub

    static final class Hub {
        final String id;
        final double lon;
        final double lat;
        Hub(String id, double lon, double lat) {
            this.id = id;
            this.lon = lon;
            this.lat = lat;
        }
    }

    private static final List<Hub> HUBS = new ArrayList<>();
    private static final Map<String, Integer> INDEX = new HashMap<>();
    private static final List<List<int[]>> ADJ = new ArrayList<>(); // [neighborIdx, distMeters]

    static {
        // --- US West Coast & Mountain West ---
        addHub("SEA", -122.3321, 47.6062); // Seattle, WA (I-5/I-90)
        addHub("PDX", -122.6765, 45.5231); // Portland, OR (I-5/I-84)
        addHub("MFR", -122.8756, 42.3265); // Medford, OR (I-5)
        addHub("RDD", -122.3917, 40.5865); // Redding, CA (I-5)
        addHub("SAC", -121.4944, 38.5816); // Sacramento, CA (I-5/I-80)
        addHub("SFO", -122.2711, 37.8044); // Oakland/Bay Area, CA (I-80/I-580)
        addHub("FAT", -119.7871, 36.7378); // Fresno, CA (CA-99)
        addHub("BFL", -119.0187, 35.3733); // Bakersfield, CA (CA-99/I-5)
        addHub("LAX", -118.2437, 34.0522); // Los Angeles, CA (I-5/I-10)
        addHub("SAN", -117.1611, 32.7157); // San Diego, CA (I-5/I-8)
        addHub("DAG", -117.0228, 34.8958); // Barstow, CA (I-15/I-40)
        addHub("IGM", -114.0530, 35.1894); // Kingman, AZ (I-40)
        addHub("RNO", -119.8138, 39.5296); // Reno, NV (I-80)
        addHub("EKO", -115.7631, 40.8324); // Elko, NV (I-80)
        addHub("LAS", -115.1398, 36.1699); // Las Vegas, NV (I-15)
        addHub("BOI", -116.2023, 43.6150); // Boise, ID (I-84)
        addHub("GEG", -117.4260, 47.6588); // Spokane, WA (I-90)
        addHub("MSO", -113.9940, 46.8721); // Missoula, MT (I-90)
        addHub("BTM", -112.5348, 46.0038); // Butte, MT (I-90/I-15)
        addHub("BIL", -108.5007, 45.7833); // Billings, MT (I-90/I-94)
        addHub("GTF", -111.3008, 47.5053); // Great Falls, MT (I-15)
        addHub("PIH", -112.4455, 42.8713); // Pocatello, ID (I-15/I-86)
        addHub("SLC", -111.8910, 40.7608); // Salt Lake City, UT (I-80/I-15)
        addHub("CVF", -112.5891, 38.6019); // Cove Fort, UT (I-15/I-70)
        addHub("GJT", -108.5506, 39.0639); // Grand Junction, CO (I-70)
        addHub("RWL", -107.2387, 41.7911); // Rawlins, WY (I-80)
        addHub("CYS", -104.8202, 41.1400); // Cheyenne, WY (I-80/I-25)
        addHub("DEN", -104.9903, 39.7392); // Denver, CO (I-70/I-25)
        addHub("PHX", -112.0740, 33.4484); // Phoenix, AZ (I-10/I-17)
        addHub("FLG", -111.6513, 35.1983); // Flagstaff, AZ (I-40/I-17)
        addHub("TUS", -110.9747, 32.2226); // Tucson, AZ (I-10)
        addHub("ABQ", -106.6504, 35.0844); // Albuquerque, NM (I-40/I-25)
        addHub("ELP", -106.4850, 31.7619); // El Paso, TX (I-10/I-25)

        // --- US Plains & Midwest ---
        addHub("RAP", -103.2310, 44.0805); // Rapid City, SD (I-90)
        addHub("BIS", -100.7837, 46.8083); // Bismarck, ND (I-94)
        addHub("FAR", -96.7898, 46.8772);  // Fargo, ND (I-94/I-29)
        addHub("FSD", -96.7311, 43.5460);  // Sioux Falls, SD (I-90/I-29)
        addHub("LBF", -100.7654, 41.1239); // North Platte, NE (I-80)
        addHub("OMA", -95.9345, 41.2565);  // Omaha, NE (I-80/I-29)
        addHub("SLN", -97.6114, 38.8403);  // Salina, KS (I-70/I-135)
        addHub("ICT", -97.3301, 37.6872);  // Wichita, KS (I-35)
        addHub("AMA", -101.8313, 35.2220); // Amarillo, TX (I-40)
        addHub("OKC", -97.5164, 35.4676);  // Oklahoma City, OK (I-40/I-35)
        addHub("FSM", -94.3985, 35.3859);  // Fort Smith, AR (I-40)
        addHub("DAL", -96.7970, 32.7767);  // Dallas, TX (I-35/I-20/I-30)
        addHub("FTW", -97.3308, 32.7555);  // Fort Worth, TX (I-20/I-35W)
        addHub("MAF", -102.0779, 31.9973); // Midland, TX (I-20)
        addHub("SAT", -98.4936, 29.4241);  // San Antonio, TX (I-10/I-35)
        addHub("LRD", -99.5075, 27.5036);  // Laredo, TX (I-35)
        addHub("HOU", -95.3698, 29.7604);  // Houston, TX (I-10/I-45)
        addHub("MSP", -93.2650, 44.9778);  // Minneapolis, MN (I-94/I-35)
        addHub("DSM", -93.6250, 41.5868);  // Des Moines, IA (I-80/I-35)
        addHub("MCI", -94.5786, 39.0997);  // Kansas City, MO (I-70/I-35)
        addHub("SGF", -93.2923, 37.2090);  // Springfield, MO (I-44)
        addHub("LIT", -92.2896, 34.7465);  // Little Rock, AR (I-40/I-30)
        addHub("SHV", -93.7502, 32.5252);  // Shreveport, LA (I-20/I-49)
        addHub("BTR", -91.1871, 30.4515);  // Baton Rouge, LA (I-10/I-12)
        addHub("MSY", -90.0715, 29.9511);  // New Orleans, LA (I-10)
        addHub("STL", -90.1994, 38.6270);  // St. Louis, MO (I-70/I-55/I-64)
        addHub("MEM", -90.0490, 35.1495);  // Memphis, TN (I-40/I-55)
        addHub("JAN", -90.1848, 32.2988);  // Jackson, MS (I-20/I-55)
        addHub("MSN", -89.4012, 43.0731);  // Madison, WI (I-90/I-94)
        addHub("ORD", -87.6298, 41.8781);  // Chicago, IL (I-80/I-90/I-94/I-55)
        addHub("IND", -86.1581, 39.7684);  // Indianapolis, IN (I-70/I-65)
        addHub("SDF", -85.7585, 38.2527);  // Louisville, KY (I-64/I-65)
        addHub("BNA", -86.7816, 36.1627);  // Nashville, TN (I-40/I-65/I-24)
        addHub("BHM", -86.8104, 33.5186);  // Birmingham, AL (I-20/I-65)
        addHub("MOB", -88.0399, 30.6954);  // Mobile, AL (I-10/I-65)
        addHub("DTW", -83.0458, 42.3314);  // Detroit, MI (I-75/I-94)
        addHub("TOL", -83.5379, 41.6528);  // Toledo, OH (I-80/I-75)
        addHub("CLE", -81.6944, 41.4993);  // Cleveland, OH (I-80/I-90/I-71)
        addHub("CMH", -82.9988, 39.9612);  // Columbus, OH (I-70/I-71)
        addHub("CVG", -84.5120, 39.1031);  // Cincinnati, OH (I-75/I-71)
        addHub("LEX", -84.5037, 38.0406);  // Lexington, KY (I-75/I-64)
        addHub("TYS", -83.9207, 35.9606);  // Knoxville, TN (I-40/I-75/I-81)
        addHub("CHA", -85.3097, 35.0456);  // Chattanooga, TN (I-75/I-24)
        addHub("ATL", -84.3880, 33.7490);  // Atlanta, GA (I-75/I-85/I-20)
        addHub("TLH", -84.2807, 30.4383);  // Tallahassee, FL (I-10)
        addHub("JAX", -81.6557, 30.3322);  // Jacksonville, FL (I-10/I-95)
        addHub("MCO", -81.3792, 28.5383);  // Orlando, FL (I-4/I-95)
        addHub("TPA", -82.4572, 27.9506);  // Tampa, FL (I-75/I-4)
        addHub("MIA", -80.1918, 25.7617);  // Miami, FL (I-95)

        // --- US East Coast & Appalachia ---
        addHub("PIT", -79.9959, 40.4406);  // Pittsburgh, PA (I-76/I-79)
        addHub("CRW", -81.6326, 38.3498);  // Charleston, WV (I-64/I-77)
        addHub("ROA", -79.9414, 37.2710);  // Roanoke, VA (I-81)
        addHub("CLT", -80.8431, 35.2271);  // Charlotte, NC (I-77/I-85)
        addHub("RDU", -78.6382, 35.7796);  // Raleigh, NC (I-40/I-85)
        addHub("SAV", -81.0912, 32.0809);  // Savannah, GA (I-95/I-16)
        addHub("RIC", -77.4360, 37.5407);  // Richmond, VA (I-95/I-64)
        addHub("DCA", -77.0369, 38.9072);  // Washington, DC (I-95/I-66)
        addHub("PHL", -75.1652, 39.9526);  // Philadelphia, PA (I-95/I-76)
        addHub("NYC", -74.0060, 40.7128);  // New York, NY (I-95/I-80)
        addHub("BUF", -78.8784, 42.8864);  // Buffalo, NY (I-90)
        addHub("SYR", -76.1474, 43.0481);  // Syracuse, NY (I-90/I-81)
        addHub("ALB", -73.7562, 42.6526);  // Albany, NY (I-90/I-87)
        addHub("BOS", -71.0589, 42.3601);  // Boston, MA (I-90/I-95)
        addHub("BGR", -68.7778, 44.8016);  // Bangor, ME (I-95)

        // --- Canada (Trans-Canada & Major Corridors) ---
        addHub("YVR", -123.1207, 49.2827); // Vancouver, BC
        addHub("YKA", -120.3273, 50.6745); // Kamloops, BC
        addHub("YYC", -114.0719, 51.0447); // Calgary, AB
        addHub("YEG", -113.4938, 53.5461); // Edmonton, AB
        addHub("YQR", -104.6189, 50.4452); // Regina, SK
        addHub("YXE", -106.6700, 52.1332); // Saskatoon, SK
        addHub("YWG", -97.1384, 49.8951);  // Winnipeg, MB
        addHub("YQT", -89.2477, 48.3809);  // Thunder Bay, ON
        addHub("YAM", -84.3461, 46.5136);  // Sault Ste. Marie, ON
        addHub("YSB", -80.9930, 46.4917);  // Sudbury, ON
        addHub("YYZ", -79.3832, 43.6532);  // Toronto, ON
        addHub("YOW", -75.6972, 45.4215);  // Ottawa, ON
        addHub("YUL", -73.5673, 45.5017);  // Montreal, QC
        addHub("YQB", -71.2080, 46.8139);  // Quebec City, QC
        addHub("YFC", -66.6431, 45.9636);  // Fredericton, NB
        addHub("YHZ", -63.5752, 44.6488);  // Halifax, NS

        // --- Mexico (Major Federal Corridors) ---
        addHub("TIJ", -117.0382, 32.5149); // Tijuana, BC
        addHub("MXL", -115.4523, 32.6245); // Mexicali, BC
        addHub("HMO", -110.9559, 29.0729); // Hermosillo, SON
        addHub("CUL", -107.3940, 24.8091); // Culiacan, SIN
        addHub("GDL", -103.3496, 20.6597); // Guadalajara, JAL
        addHub("CUU", -106.0691, 28.6330); // Chihuahua, CHIH
        addHub("TRC", -103.4068, 25.5428); // Torreon, COAH
        addHub("MTY", -100.3161, 25.6866); // Monterrey, NL
        addHub("SLP", -100.9855, 22.1565); // San Luis Potosi, SLP
        addHub("QRO", -100.3899, 20.5888); // Queretaro, QRO
        addHub("MEX", -99.1332, 19.4326);  // Mexico City, CDMX
        addHub("VER", -96.1342, 19.1738);  // Veracruz, VER
        addHub("VSA", -92.9475, 17.9892);  // Villahermosa, TAB
        addHub("MID", -89.5926, 20.9674);  // Merida, YUC

        // --- US Interstate Edges ---
        // I-5 & West Coast
        connect("YVR", "SEA"); connect("SEA", "PDX"); connect("PDX", "MFR"); connect("MFR", "RDD");
        connect("RDD", "SAC"); connect("SAC", "SFO"); connect("SAC", "FAT"); connect("SFO", "FAT");
        connect("FAT", "BFL"); connect("BFL", "LAX"); connect("LAX", "SAN"); connect("SAN", "TIJ"); connect("LAX", "DAG");
        connect("BFL", "DAG"); connect("SAN", "DAG"); connect("RDD", "RNO"); // CA-44/US-395
        // I-80
        connect("SFO", "SAC"); connect("SAC", "RNO"); connect("RNO", "EKO"); connect("EKO", "SLC");
        connect("SLC", "RWL"); connect("RWL", "CYS"); connect("CYS", "LBF"); connect("LBF", "OMA");
        connect("OMA", "DSM"); connect("DSM", "ORD"); connect("ORD", "TOL"); connect("TOL", "CLE");
        connect("CLE", "PIT"); connect("CLE", "NYC"); connect("PIT", "PHL"); connect("PHL", "NYC");
        // I-84 / I-90 / I-94
        connect("PDX", "BOI"); connect("BOI", "PIH"); connect("BOI", "SLC");
        connect("SEA", "GEG"); connect("GEG", "MSO"); connect("MSO", "BTM"); connect("BTM", "BIL");
        connect("BIL", "RAP"); connect("RAP", "FSD"); connect("FSD", "MSP"); connect("FSD", "OMA");
        connect("BIL", "BIS"); connect("BIS", "FAR"); connect("FAR", "MSP"); connect("FAR", "YWG");
        connect("MSP", "MSN"); connect("MSN", "ORD"); connect("ORD", "DTW"); connect("DTW", "TOL");
        connect("CLE", "BUF"); connect("BUF", "SYR"); connect("SYR", "ALB"); connect("ALB", "BOS");
        connect("ALB", "NYC"); connect("BOS", "BGR"); connect("BGR", "YFC");
        // I-15 / I-25
        connect("DAG", "LAS"); connect("LAS", "CVF"); connect("CVF", "SLC"); connect("SLC", "PIH");
        connect("PIH", "BTM"); connect("BTM", "GTF"); connect("GTF", "YYC");
        connect("BIL", "CYS"); connect("CYS", "DEN"); connect("DEN", "ABQ"); connect("ABQ", "ELP");
        // I-70
        connect("CVF", "GJT"); connect("GJT", "DEN"); connect("DEN", "SLN"); connect("DEN", "LBF");
        connect("SLN", "MCI"); connect("MCI", "STL"); connect("STL", "IND"); connect("IND", "CMH");
        connect("CMH", "PIT"); connect("PIT", "DCA"); connect("CMH", "CLE");
        // I-40 / I-44
        connect("DAG", "IGM"); connect("IGM", "FLG"); connect("IGM", "LAS"); connect("FLG", "PHX"); connect("FLG", "ABQ"); connect("ABQ", "AMA");
        connect("AMA", "OKC"); connect("OKC", "SGF"); connect("SGF", "STL"); connect("OKC", "FSM"); connect("FSM", "LIT");
        connect("LIT", "MEM"); connect("MEM", "BNA"); connect("BNA", "TYS"); connect("TYS", "CLT");
        connect("TYS", "RDU"); connect("CLT", "RDU");
        // I-10 / I-20 / I-30
        connect("LAX", "PHX"); connect("SAN", "PHX"); connect("PHX", "TUS"); connect("TUS", "ELP");
        connect("ELP", "MAF"); connect("MAF", "FTW"); connect("FTW", "DAL"); connect("ELP", "SAT");
        connect("SAT", "HOU"); connect("HOU", "BTR"); connect("BTR", "MSY"); connect("MSY", "MOB");
        connect("MOB", "TLH"); connect("TLH", "JAX"); connect("DAL", "SHV"); connect("SHV", "JAN");
        connect("JAN", "BHM"); connect("BHM", "ATL"); connect("ATL", "CLT"); connect("ATL", "SAV");
        connect("DAL", "LIT"); connect("DAL", "HOU");
        // I-35 / I-29 / I-55 / I-65 / I-75 / I-81 / I-95
        connect("LRD", "SAT"); connect("SAT", "DAL"); connect("DAL", "OKC"); connect("OKC", "ICT");
        connect("ICT", "SLN"); connect("ICT", "MCI"); connect("MCI", "OMA"); connect("MCI", "DSM");
        connect("DSM", "MSP"); connect("MSY", "JAN"); connect("JAN", "MEM"); connect("MEM", "STL");
        connect("STL", "ORD"); connect("MOB", "BHM"); connect("BHM", "BNA"); connect("BNA", "SDF");
        connect("SDF", "IND"); connect("IND", "ORD"); connect("STL", "SDF"); connect("SDF", "LEX");
        connect("SDF", "CVG"); connect("CVG", "CMH"); connect("CVG", "IND"); connect("CVG", "LEX");
        connect("LEX", "TYS"); connect("LEX", "CRW"); connect("CRW", "ROA"); connect("CRW", "CMH");
        connect("CRW", "PIT"); connect("TYS", "ROA"); connect("TYS", "CHA"); connect("CHA", "BNA");
        connect("CHA", "ATL"); connect("ATL", "JAX"); connect("ATL", "TLH"); connect("JAX", "MCO");
        connect("MCO", "TPA"); connect("MCO", "MIA"); connect("TPA", "MIA"); connect("TPA", "TLH");
        connect("CVG", "TOL"); connect("DTW", "YYZ"); connect("BUF", "YYZ");
        connect("ROA", "DCA"); connect("ROA", "CLT"); connect("ROA", "SYR"); connect("ROA", "RIC");
        connect("JAX", "SAV"); connect("SAV", "CLT"); connect("SAV", "RDU"); connect("RDU", "RIC");
        connect("RIC", "DCA"); connect("DCA", "PHL"); connect("NYC", "BOS");

        // --- Canada Corridors ---
        connect("YVR", "YKA"); connect("YKA", "YYC"); connect("YKA", "YEG"); connect("YYC", "YEG");
        connect("YYC", "YQR"); connect("YEG", "YXE"); connect("YXE", "YQR"); connect("YQR", "YWG");
        connect("YWG", "YQT"); connect("YQT", "YAM"); connect("YAM", "YSB"); connect("YSB", "YYZ");
        connect("YSB", "YOW"); connect("YYZ", "YOW"); connect("YYZ", "YUL"); connect("YOW", "YUL");
        connect("YUL", "YQB"); connect("YUL", "ALB"); connect("YQB", "YFC"); connect("YFC", "YHZ");

        // --- Mexico Corridors ---
        connect("TIJ", "MXL"); connect("MXL", "HMO"); connect("TUS", "HMO"); connect("HMO", "CUL");
        connect("CUL", "GDL"); connect("ELP", "CUU"); connect("CUU", "TRC"); connect("TRC", "MTY");
        connect("TRC", "SLP"); connect("LRD", "MTY"); connect("MTY", "SLP"); connect("SLP", "GDL");
        connect("SLP", "QRO"); connect("GDL", "QRO"); connect("QRO", "MEX"); connect("MEX", "VER");
        connect("VER", "VSA"); connect("VSA", "MID");
    }

    private static void addHub(String id, double lon, double lat) {
        INDEX.put(id, HUBS.size());
        HUBS.add(new Hub(id, lon, lat));
        ADJ.add(new ArrayList<>());
    }

    private static void connect(String a, String b) {
        Integer ia = INDEX.get(a);
        Integer ib = INDEX.get(b);
        if (ia == null || ib == null) return;
        Hub ha = HUBS.get(ia);
        Hub hb = HUBS.get(ib);
        int dist = (int) Math.round(OfflineSearchStore.haversineMeters(ha.lat, ha.lon, hb.lat, hb.lon));
        ADJ.get(ia).add(new int[]{ib, dist});
        ADJ.get(ib).add(new int[]{ia, dist});
    }

    /**
     * Checks whether the 5x5-degree BRouter .rd5 segment covering (lon, lat) is installed on disk.
     */
    static boolean hasRd5For(File segmentsDir, double lon, double lat) {
        if (segmentsDir == null) return true;
        int lonFloor = (int) Math.floor(lon / 5.0) * 5;
        int latFloor = (int) Math.floor(lat / 5.0) * 5;
        String ew = lonFloor < 0 ? ("W" + (-lonFloor)) : ("E" + lonFloor);
        String ns = latFloor < 0 ? ("S" + (-latFloor)) : ("N" + latFloor);
        File f = new File(segmentsDir, String.format(Locale.US, "%s_%s.rd5", ew, ns));
        return f.isFile() && f.length() > 1024;
    }

    /**
     * Expands a list of user [lon, lat] waypoints by inserting Interstate/highway corridor hubs
     * for any leg exceeding 350 miles. Short legs are untouched.
     */
    static List<double[]> expandLongLegs(List<double[]> userCoords, File segmentsDir) {
        if (userCoords == null || userCoords.size() < 2) return userCoords;
        List<double[]> out = new ArrayList<>();
        out.add(userCoords.get(0));
        for (int i = 0; i < userCoords.size() - 1; i++) {
            double[] from = userCoords.get(i);
            double[] to = userCoords.get(i + 1);
            double direct = OfflineSearchStore.haversineMeters(from[1], from[0], to[1], to[0]);
            if (direct > MIN_LEG_METERS) {
                List<double[]> hubs = planCorridor(from, to, direct, segmentsDir);
                out.addAll(hubs);
            }
            out.add(to);
        }
        return out;
    }

    private static List<double[]> planCorridor(double[] from, double[] to, double directMeters, File segmentsDir) {
        int n = HUBS.size();
        boolean[] available = new boolean[n];
        for (int i = 0; i < n; i++) {
            Hub h = HUBS.get(i);
            available[i] = hasRd5For(segmentsDir, h.lon, h.lat);
        }

        int srcNode = n;
        int dstNode = n + 1;
        double[] dist = new double[n + 2];
        int[] prev = new int[n + 2];
        Arrays.fill(dist, Double.POSITIVE_INFINITY);
        Arrays.fill(prev, -1);

        // Attach start & end to their nearest 4 available hubs within MAX_ATTACH_METERS
        List<int[]> srcEdges = nearestHubs(from[0], from[1], available, 4);
        List<int[]> dstEdges = nearestHubs(to[0], to[1], available, 4);
        if (srcEdges.isEmpty() || dstEdges.isEmpty()) return Collections.emptyList();

        Map<Integer, Integer> toDst = new HashMap<>();
        for (int[] e : dstEdges) toDst.put(e[0], e[1]);

        PriorityQueue<double[]> pq = new PriorityQueue<>((a, b) -> Double.compare(a[0], b[0]));
        dist[srcNode] = 0.0;
        pq.add(new double[]{0.0, srcNode});

        while (!pq.isEmpty()) {
            double[] cur = pq.poll();
            double d = cur[0];
            int u = (int) cur[1];
            if (d > dist[u]) continue;
            if (u == dstNode) break;

            if (u == srcNode) {
                for (int[] e : srcEdges) {
                    int v = e[0];
                    double nd = d + e[1] * 1.15;
                    if (nd < dist[v]) {
                        dist[v] = nd;
                        prev[v] = u;
                        pq.add(new double[]{nd, v});
                    }
                }
            } else {
                Integer dstCost = toDst.get(u);
                if (dstCost != null) {
                    double nd = d + dstCost * 1.15;
                    if (nd < dist[dstNode]) {
                        dist[dstNode] = nd;
                        prev[dstNode] = u;
                        pq.add(new double[]{nd, dstNode});
                    }
                }
                for (int[] e : ADJ.get(u)) {
                    int v = e[0];
                    if (!available[v]) continue;
                    double nd = d + e[1];
                    if (nd < dist[v]) {
                        dist[v] = nd;
                        prev[v] = u;
                        pq.add(new double[]{nd, v});
                    }
                }
            }
        }

        if (prev[dstNode] == -1 || dist[dstNode] > directMeters * 1.75) {
            return Collections.emptyList();
        }

        List<Hub> raw = new ArrayList<>();
        for (int cur = prev[dstNode]; cur != -1 && cur != srcNode; cur = prev[cur]) {
            raw.add(HUBS.get(cur));
        }
        Collections.reverse(raw);

        // Trim hubs too close to start or end, and thin hubs closer than MIN_HUB_SPACING_METERS
        List<double[]> selected = new ArrayList<>();
        double[] lastKept = from;
        for (int i = 0; i < raw.size(); i++) {
            Hub h = raw.get(i);
            double dFromStart = OfflineSearchStore.haversineMeters(from[1], from[0], h.lat, h.lon);
            double dToEnd = OfflineSearchStore.haversineMeters(h.lat, h.lon, to[1], to[0]);
            if (dFromStart < END_TRIM_METERS || dToEnd < END_TRIM_METERS) continue;

            double dFromLast = OfflineSearchStore.haversineMeters(lastKept[1], lastKept[0], h.lat, h.lon);
            if (dFromLast < MIN_HUB_SPACING_METERS) continue;

            double[] pt = new double[]{h.lon, h.lat};
            selected.add(pt);
            lastKept = pt;
        }
        return selected;
    }

    private static List<int[]> nearestHubs(double lon, double lat, boolean[] available, int k) {
        List<int[]> candidates = new ArrayList<>();
        for (int i = 0; i < HUBS.size(); i++) {
            if (!available[i]) continue;
            Hub h = HUBS.get(i);
            double d = OfflineSearchStore.haversineMeters(lat, lon, h.lat, h.lon);
            if (d <= MAX_ATTACH_METERS) {
                candidates.add(new int[]{i, (int) Math.round(d)});
            }
        }
        candidates.sort((a, b) -> Integer.compare(a[1], b[1]));
        return candidates.size() > k ? candidates.subList(0, k) : candidates;
    }
}
