package com.andysdevstudio.routeweather.offline;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.zip.GZIPInputStream;

/**
 * Pure-Java PMTiles v3 reader for Android WebView offline vector tiles.
 * Supports single-file regional/state .pmtiles archives with O(1) bounding-box filtering
 * and bounded LRU caching of decoded leaf directories.
 */
public final class PMTilesReader implements Closeable {
    private static final int HEADER_SIZE = 127;
    private static final int COMPRESSION_NONE = 1;
    private static final int COMPRESSION_GZIP = 2;

    public final File file;
    public final long rootDirOffset;
    public final long rootDirLength;
    public final long leafDirsOffset;
    public final long leafDirsLength;
    public final long tileDataOffset;
    public final long tileDataLength;
    public final int internalCompression;
    public final int tileCompression;
    public final int tileType;
    public final int minZoom;
    public final int maxZoom;
    public final double minLon;
    public final double minLat;
    public final double maxLon;
    public final double maxLat;

    private final RandomAccessFile raf;
    private final Entry[] rootEntries;
    private final Map<Long, Entry[]> leafCache = new LinkedHashMap<Long, Entry[]>(32, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<Long, Entry[]> eldest) {
            return size() > 32;
        }
    };

    private static final class Entry {
        final long tileId;
        final long offset;
        final int length;
        final int runLength;

        Entry(long tileId, long offset, int length, int runLength) {
            this.tileId = tileId;
            this.offset = offset;
            this.length = length;
            this.runLength = runLength;
        }
    }

    public PMTilesReader(File file) throws IOException {
        this.file = file;
        this.raf = new RandomAccessFile(file, "r");
        try {
            byte[] hdr = new byte[HEADER_SIZE];
            raf.readFully(hdr);
            if (hdr[0] != 'P' || hdr[1] != 'M' || hdr[2] != 'T' || hdr[3] != 'i'
                    || hdr[4] != 'l' || hdr[5] != 'e' || hdr[6] != 's' || hdr[7] != 3) {
                throw new IOException("Unsupported PMTiles file (expected v3): " + file.getName());
            }
            ByteBuffer bb = ByteBuffer.wrap(hdr).order(ByteOrder.LITTLE_ENDIAN);
            this.rootDirOffset = bb.getLong(8);
            this.rootDirLength = bb.getLong(16);
            // jsonMetadataOffset = 24, jsonMetadataLength = 32
            this.leafDirsOffset = bb.getLong(40);
            this.leafDirsLength = bb.getLong(48);
            this.tileDataOffset = bb.getLong(56);
            this.tileDataLength = bb.getLong(64);
            // numAddressedTiles = 72, numTileEntries = 80, numTileContents = 88, clustered = 96
            this.internalCompression = hdr[97] & 0xFF;
            this.tileCompression = hdr[98] & 0xFF;
            this.tileType = hdr[99] & 0xFF;
            this.minZoom = hdr[100] & 0xFF;
            this.maxZoom = hdr[101] & 0xFF;
            this.minLon = bb.getInt(102) / 1e7;
            this.minLat = bb.getInt(106) / 1e7;
            this.maxLon = bb.getInt(110) / 1e7;
            this.maxLat = bb.getInt(114) / 1e7;

            byte[] rootBytes = readRange(rootDirOffset, (int) rootDirLength);
            this.rootEntries = decodeDirectory(decompress(rootBytes, internalCompression));
        } catch (IOException | RuntimeException e) {
            try { raf.close(); } catch (IOException ignored) {}
            throw e;
        }
    }

    public boolean mightContainTile(int z, int x, int y) {
        if (z < minZoom || z > maxZoom) return false;
        double n = Math.pow(2.0, z);
        double tileWest = x / n * 360.0 - 180.0;
        double tileEast = (x + 1) / n * 360.0 - 180.0;
        double tileNorth = Math.toDegrees(Math.atan(Math.sinh(Math.PI * (1.0 - 2.0 * y / n))));
        double tileSouth = Math.toDegrees(Math.atan(Math.sinh(Math.PI * (1.0 - 2.0 * (y + 1) / n))));
        return tileEast >= minLon && tileWest <= maxLon && tileNorth >= minLat && tileSouth <= maxLat;
    }

    /**
     * Returns uncompressed MVT tile bytes for (z, x, y), or null if tile is not present.
     */
    public byte[] getTile(int z, int x, int y) throws IOException {
        if (!mightContainTile(z, x, y)) return null;
        long tileId = zxyToTileId(z, x, y);
        Entry[] dir = rootEntries;
        for (int depth = 0; depth <= 3; depth++) {
            Entry match = findTile(dir, tileId);
            if (match == null) return null;
            if (match.runLength > 0) {
                byte[] raw = readRange(tileDataOffset + match.offset, match.length);
                return decompress(raw, tileCompression);
            }
            // Leaf directory pointer
            dir = loadLeafDirectory(match.offset, match.length);
        }
        return null;
    }

    private Entry[] loadLeafDirectory(long offset, int length) throws IOException {
        synchronized (leafCache) {
            Entry[] cached = leafCache.get(offset);
            if (cached != null) return cached;
        }
        byte[] raw = readRange(leafDirsOffset + offset, length);
        Entry[] decoded = decodeDirectory(decompress(raw, internalCompression));
        synchronized (leafCache) {
            leafCache.put(offset, decoded);
        }
        return decoded;
    }

    private synchronized byte[] readRange(long offset, int length) throws IOException {
        if (length < 0 || length > 32 * 1024 * 1024) {
            throw new IOException("Invalid PMTiles read length: " + length);
        }
        byte[] buf = new byte[length];
        raf.seek(offset);
        raf.readFully(buf);
        return buf;
    }

    private static byte[] decompress(byte[] input, int compression) throws IOException {
        if (compression == COMPRESSION_NONE || compression == 0) return input;
        if (compression == COMPRESSION_GZIP) {
            try (InputStream gz = new GZIPInputStream(new ByteArrayInputStream(input));
                 ByteArrayOutputStream out = new ByteArrayOutputStream(input.length * 2)) {
                byte[] buf = new byte[4096];
                int n;
                while ((n = gz.read(buf)) != -1) out.write(buf, 0, n);
                return out.toByteArray();
            }
        }
        throw new IOException("Unsupported PMTiles compression: " + compression);
    }

    private static Entry findTile(Entry[] entries, long tileId) {
        int low = 0;
        int high = entries.length - 1;
        while (low <= high) {
            int mid = (low + high) >>> 1;
            long midId = entries[mid].tileId;
            if (tileId < midId) {
                high = mid - 1;
            } else if (tileId > midId) {
                low = mid + 1;
            } else {
                return entries[mid];
            }
        }
        if (high >= 0) {
            Entry candidate = entries[high];
            if (candidate.runLength == 0 || tileId < candidate.tileId + candidate.runLength) {
                return candidate;
            }
        }
        return null;
    }

    private static Entry[] decodeDirectory(byte[] bytes) {
        int[] pos = new int[]{0};
        int numEntries = (int) readVarint(bytes, pos);
        long[] tileIds = new long[numEntries];
        long lastId = 0;
        for (int i = 0; i < numEntries; i++) {
            lastId += readVarint(bytes, pos);
            tileIds[i] = lastId;
        }
        int[] runLengths = new int[numEntries];
        for (int i = 0; i < numEntries; i++) {
            runLengths[i] = (int) readVarint(bytes, pos);
        }
        int[] lengths = new int[numEntries];
        for (int i = 0; i < numEntries; i++) {
            lengths[i] = (int) readVarint(bytes, pos);
        }
        Entry[] entries = new Entry[numEntries];
        long prevOffset = 0;
        int prevLength = 0;
        for (int i = 0; i < numEntries; i++) {
            long tmp = readVarint(bytes, pos);
            long offset = (i > 0 && tmp == 0) ? (prevOffset + prevLength) : (tmp - 1);
            entries[i] = new Entry(tileIds[i], offset, lengths[i], runLengths[i]);
            prevOffset = offset;
            prevLength = lengths[i];
        }
        return entries;
    }

    private static long readVarint(byte[] bytes, int[] pos) {
        long result = 0;
        int shift = 0;
        while (pos[0] < bytes.length) {
            int b = bytes[pos[0]++] & 0xFF;
            result |= (long) (b & 0x7F) << shift;
            if ((b & 0x80) == 0) return result;
            shift += 7;
        }
        return result;
    }

    public static long zxyToTileId(int z, int x, int y) {
        if (z == 0) return 0;
        long baseId = 0;
        for (int i = 0; i < z; i++) {
            baseId += (1L << (2 * i));
        }
        long n = 1L << z;
        long rx, ry, d = 0;
        long tx = x;
        long ty = y;
        for (long s = n >>> 1; s > 0; s >>>= 1) {
            rx = (tx & s) > 0 ? 1 : 0;
            ry = (ty & s) > 0 ? 1 : 0;
            d += s * s * ((3 * rx) ^ ry);
            if (ry == 0) {
                if (rx == 1) {
                    tx = n - 1 - tx;
                    ty = n - 1 - ty;
                }
                long tmp = tx;
                tx = ty;
                ty = tmp;
            }
        }
        return baseId + d;
    }

    @Override
    public void close() throws IOException {
        raf.close();
    }
}
