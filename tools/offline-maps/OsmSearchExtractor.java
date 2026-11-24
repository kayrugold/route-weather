import com.onthegomap.planetiler.collection.LongLongMap;
import com.onthegomap.planetiler.reader.osm.OsmBlockSource;
import com.onthegomap.planetiler.reader.osm.OsmElement;
import com.onthegomap.planetiler.reader.osm.OsmInputFile;

import java.io.BufferedWriter;
import java.io.FileWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Extracts driving-focused offline search records (cities, towns, streets, addresses,
 * truck stops, weigh stations, fuel, rest areas, hospitals, lodging, food) from an OSM .pbf
 * using Planetiler's fast PBF reader. Outputs tab-separated lines for SQLite FTS5 import.
 *
 * Usage:
 *   javac -cp planetiler.jar OsmSearchExtractor.java
 *   java -Xmx4g -cp .;planetiler.jar OsmSearchExtractor <input.osm.pbf> <output.tsv> [defaultStateCode]
 */
public final class OsmSearchExtractor {
    private static final Set<String> DRIVABLE_HIGHWAYS = Set.of(
            "motorway", "trunk", "primary", "secondary", "tertiary",
            "unclassified", "residential", "living_street", "motorway_link", "trunk_link"
    );

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("Usage: OsmSearchExtractor <input.osm.pbf> <output.tsv> [defaultState]");
            System.exit(1);
        }
        Path pbf = Path.of(args[0]);
        Path outPath = Path.of(args[1]);
        String defaultState = args.length >= 3 ? args[2] : "";
        boolean includeHouseNumbers = args.length >= 4 && "--include-house-numbers".equals(args[3]);

        long t0 = System.currentTimeMillis();
        // Memory-mapped disk-backed node coordinate map (handles 500M+ nodes in <1 GB RAM!)
        Path nodeMapFile = Files.createTempFile("rw-nodemap-", ".bin");
        Set<String> seenStreets = new HashSet<>(500_000);
        Set<String> seenAddresses = new HashSet<>(100_000);
        int[] counts = new int[1];

        try (LongLongMap nodeCoords = LongLongMap.from("sparsearray", "mmap", nodeMapFile, true);
             BufferedWriter out = new BufferedWriter(new FileWriter(outPath.toFile(), StandardCharsets.UTF_8), 1 << 20);
             OsmBlockSource source = OsmInputFile.readFrom(pbf)) {

            final LongLongMap.Writer[] writerRef = new LongLongMap.Writer[]{ nodeCoords.newWriter() };

            source.forEachBlock(block -> {
                for (OsmElement el : block.decodeElements()) {
                    if (el instanceof OsmElement.Node node) {
                        long packed = pack(node.lat(), node.lon());
                        writerRef[0].put(node.id(), packed);
                        Map<String, Object> tags = node.tags();
                        if (!tags.isEmpty()) {
                            emitFeature(out, tags, node.lat(), node.lon(), defaultState, includeHouseNumbers, seenAddresses, counts);
                        }
                    } else if (el instanceof OsmElement.Way way) {
                        if (writerRef[0] != null) {
                            try { writerRef[0].close(); } catch (Exception ignored) {}
                            writerRef[0] = null;
                        }
                        Map<String, Object> tags = way.tags();
                        if (tags.isEmpty()) continue;
                        var nodes = way.nodes();
                        if (nodes == null || nodes.isEmpty()) continue;
                        long midNodeId = nodes.get(nodes.size() / 2);
                        long packed = nodeCoords.get(midNodeId);
                        if (packed == LongLongMap.MISSING_VALUE) continue;
                        double lat = unpackLat(packed);
                        double lon = unpackLon(packed);

                        String highway = str(tags, "highway");
                        if (highway != null && DRIVABLE_HIGHWAYS.contains(highway)) {
                            String name = str(tags, "name");
                            String ref = str(tags, "ref");
                            String label = name != null ? name : ref;
                            if (label != null && label.length() >= 2) {
                                // Deduplicate streets per ~10km grid cell to keep index compact
                                int gx = (int) Math.floor(lon * 10.0);
                                int gy = (int) Math.floor(lat * 10.0);
                                String key = label.toLowerCase(Locale.US) + "|" + gx + "|" + gy;
                                if (seenStreets.add(key)) {
                                    String full = (ref != null && name != null && !name.contains(ref))
                                            ? name + " (" + ref + ")" : label;
                                    if (!defaultState.isEmpty()) full += ", " + defaultState;
                                    int rank = highway.startsWith("motorway") || highway.startsWith("trunk") ? 45
                                            : highway.equals("primary") || highway.equals("secondary") ? 35 : 20;
                                    writeRow(out, full, "Road", "street", "", lat, lon, rank, counts);
                                }
                            }
                            continue;
                        }
                        emitFeature(out, tags, lat, lon, defaultState, includeHouseNumbers, seenAddresses, counts);
                    }
                }
            });
            if (writerRef[0] != null) {
                try { writerRef[0].close(); } catch (Exception ignored) {}
            }
        } finally {
            Files.deleteIfExists(nodeMapFile);
        }
        System.out.printf(Locale.US, "Extracted %,d search records in %.1f s%n",
                counts[0], (System.currentTimeMillis() - t0) / 1000.0);
    }

    private static void emitFeature(BufferedWriter out, Map<String, Object> tags, double lat, double lon,
                                    String defaultState, boolean includeHouseNumbers, Set<String> seenAddresses, int[] counts) {
        // 1. Places (cities, towns, villages, hamlets, suburbs)
        String place = str(tags, "place");
        String name = str(tags, "name");
        if (place != null && name != null) {
            int rank = switch (place) {
                case "city" -> 100;
                case "town" -> 85;
                case "village" -> 70;
                case "suburb", "neighbourhood" -> 60;
                case "hamlet" -> 55;
                default -> 0;
            };
            if (rank > 0) {
                String state = firstNonEmpty(str(tags, "is_in:state_code"), str(tags, "addr:state"), defaultState);
                String display = state.isEmpty() ? name : (name + ", " + state);
                writeRow(out, display, capitalize(place), "place", "", lat, lon, rank, counts);
                return;
            }
        }

        // 2. Driving & Safety POIs (truck stops, weigh stations/DOT scales, fuel, rest areas, hospitals, police, fire, repair, lodging, food, parking)
        String amenity = str(tags, "amenity");
        String highway = str(tags, "highway");
        String barrier = str(tags, "barrier");
        String tourism = str(tags, "tourism");
        String shop = str(tags, "shop");
        String brand = firstNonEmpty(str(tags, "brand"), str(tags, "operator"), "");
        String city = str(tags, "addr:city");
        String state = firstNonEmpty(str(tags, "addr:state"), defaultState);
        String nameLower = name != null ? name.toLowerCase(Locale.US) : "";

        if ("weighbridge".equals(amenity) || "weigh_station".equals(amenity)
                || "weigh_station".equals(highway) || "weighbridge".equals(barrier)
                || nameLower.contains("weigh station") || nameLower.contains("inspection facility")
                || nameLower.contains("truck scale") || nameLower.contains("cat scale")) {
            String display = appendCityState(name != null ? name : "Weigh Station", city, state);
            writeRow(out, display, "Weigh Station", "weigh_station", brand, lat, lon, 68, counts);
            return;
        }
        if ("rest_area".equals(highway) || "services".equals(highway)) {
            String display = appendCityState(name != null ? name : "Rest Area", city, state);
            writeRow(out, display, "Rest Area", "rest_area", brand, lat, lon, 64, counts);
            return;
        }
        if ("fuel".equals(amenity)) {
            boolean isTruck = isTruckStop(name, brand, tags);
            String label = name != null ? name : (!brand.isEmpty() ? brand + " Fuel" : "Fuel Station");
            String display = appendCityState(label, city, state);
            writeRow(out, display, isTruck ? "Truck Stop" : "Fuel Station",
                    isTruck ? "truck_stop" : "fuel", brand, lat, lon, isTruck ? 72 : 50, counts);
            return;
        }
        if (("hospital".equals(amenity) || "clinic".equals(amenity)) && name != null) {
            String sub = "hospital".equals(amenity) ? "Hospital" : "Urgent Care / Clinic";
            writeRow(out, appendCityState(name, city, state), sub, "hospital", brand, lat, lon, "hospital".equals(amenity) ? 70 : 58, counts);
            return;
        }
        if ("police".equals(amenity) && name != null) {
            writeRow(out, appendCityState(name, city, state), "Police / Patrol", "police", brand, lat, lon, 62, counts);
            return;
        }
        if ("fire_station".equals(amenity) && name != null) {
            writeRow(out, appendCityState(name, city, state), "Fire Station", "fire_station", brand, lat, lon, 54, counts);
            return;
        }
        if (("car_repair".equals(shop) || "tyres".equals(shop) || "truck_repair".equals(amenity)) && name != null) {
            String sub = "tyres".equals(shop) ? "Tire Shop" : "Auto / Truck Repair";
            writeRow(out, appendCityState(name, city, state), sub, "repair", brand, lat, lon, 52, counts);
            return;
        }
        if ("pharmacy".equals(amenity) && name != null) {
            writeRow(out, appendCityState(name, city, state), "Pharmacy", "pharmacy", brand, lat, lon, 46, counts);
            return;
        }
        if (("hotel".equals(tourism) || "motel".equals(tourism)) && name != null) {
            writeRow(out, appendCityState(name, city, state), capitalize(tourism), "lodging", brand, lat, lon, 45, counts);
            return;
        }
        if (("fast_food".equals(amenity) || "restaurant".equals(amenity)) && name != null) {
            writeRow(out, appendCityState(name, city, state), "Food", "food", brand, lat, lon, 38, counts);
            return;
        }
        if ("parking".equals(amenity) && ("yes".equals(str(tags, "hgv")) || "designated".equals(str(tags, "hgv")))) {
            String label = name != null ? name : "Truck Parking";
            writeRow(out, appendCityState(label, city, state), "Truck Parking", "parking", brand, lat, lon, 58, counts);
            return;
        }

        // 3. Street Addresses (house number + street — optional, omitted by default to stay well under 5 GB nationwide)
        if (!includeHouseNumbers) return;
        String house = str(tags, "addr:housenumber");
        String street = str(tags, "addr:street");
        if (house != null && street != null) {
            String display = appendCityState(house + " " + street, city, state);
            String key = display.toLowerCase(Locale.US);
            if (seenAddresses.add(key)) {
                writeRow(out, display, "Address", "address", "", lat, lon, 15, counts);
            }
        }
    }

    private static boolean isTruckStop(String name, String brand, Map<String, Object> tags) {
        if ("yes".equals(str(tags, "hgv")) || "designated".equals(str(tags, "hgv"))
                || "yes".equals(str(tags, "fuel:HGV_diesel"))) return true;
        String combined = ((name != null ? name : "") + " " + brand).toLowerCase(Locale.US);
        return combined.contains("pilot") || combined.contains("flying j") || combined.contains("love's")
                || combined.contains("loves") || combined.contains("petro") || combined.contains("travelcenters")
                || combined.contains("ta ") || combined.endsWith(" ta") || combined.contains("truck stop")
                || combined.contains("travel center") || combined.contains("sapp bros") || combined.contains("buc-ee");
    }

    private static String appendCityState(String base, String city, String state) {
        StringBuilder sb = new StringBuilder(base);
        if (city != null && !city.isEmpty()) sb.append(", ").append(city);
        if (state != null && !state.isEmpty()) sb.append(", ").append(state);
        return sb.toString();
    }

    private static void writeRow(BufferedWriter out, String name, String subtitle, String category,
                                 String brand, double lat, double lon, int rank, int[] counts) {
        try {
            out.write(clean(name));
            out.write('\t');
            out.write(clean(subtitle));
            out.write('\t');
            out.write(clean(category));
            out.write('\t');
            out.write(clean(brand));
            out.write('\t');
            out.write(String.format(Locale.US, "%.5f", lat));
            out.write('\t');
            out.write(String.format(Locale.US, "%.5f", lon));
            out.write('\t');
            out.write(Integer.toString(rank));
            out.write('\n');
            counts[0]++;
        } catch (Exception ignored) {}
    }

    private static String clean(String s) {
        if (s == null) return "";
        return s.replace('\t', ' ').replace('\r', ' ').replace('\n', ' ').trim();
    }

    private static String str(Map<String, Object> tags, String key) {
        Object v = tags.get(key);
        if (v == null) return null;
        String s = v.toString().trim();
        return s.isEmpty() ? null : s;
    }

    private static String firstNonEmpty(String... values) {
        for (String v : values) if (v != null && !v.isEmpty()) return v;
        return "";
    }

    private static String capitalize(String s) {
        if (s == null || s.isEmpty()) return "";
        return Character.toUpperCase(s.charAt(0)) + s.substring(1);
    }

    private static long pack(double lat, double lon) {
        long latE7 = Math.round(lat * 1e7);
        long lonE7 = Math.round(lon * 1e7);
        return (latE7 << 32) | (lonE7 & 0xFFFFFFFFL);
    }

    private static double unpackLat(long packed) {
        return ((int) (packed >> 32)) / 1e7;
    }

    private static double unpackLon(long packed) {
        return ((int) packed) / 1e7;
    }
}
