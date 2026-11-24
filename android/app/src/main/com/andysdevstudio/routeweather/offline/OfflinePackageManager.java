package com.andysdevstudio.routeweather.offline;

import android.content.Context;
import android.os.StatFs;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Manages downloadable offline map packages (.pmtiles, .rd5, -search.db) from Cloudflare R2.
 * Supports resumable HTTP Range downloads, pause/resume/cancel, SHA-256 verification,
 * available-space checks, atomic installation, corruption checks, and package deletion.
 */
public final class OfflinePackageManager {
    private static final String TAG = "RouteWeatherOfflinePkg";
    private static final long SAFETY_BUFFER_BYTES = 250L * 1024L * 1024L;

    public interface Listener {
        void onProgress(String packageId, String state, long downloadedBytes, long totalBytes, String message);
        void onInstalledChanged();
    }

    private final File rootDir;
    private final File tilesDir;
    private final File routingDir;
    private final File searchDir;
    private final File tmpDir;
    private final File installedFile;
    private final Listener listener;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Map<String, AtomicBoolean> cancelFlags = new ConcurrentHashMap<>();

    public OfflinePackageManager(Context context, Listener listener) {
        File base = context.getExternalFilesDir("offline-maps");
        if (base == null) base = new File(context.getFilesDir(), "offline-maps");
        this.rootDir = base;
        this.tilesDir = new File(base, "tiles");
        this.routingDir = new File(base, "routing");
        this.searchDir = new File(base, "search");
        this.tmpDir = new File(base, "tmp");
        this.installedFile = new File(base, "installed.json");
        this.listener = listener;
        ensureDirs();
    }

    private void ensureDirs() {
        rootDir.mkdirs();
        tilesDir.mkdirs();
        routingDir.mkdirs();
        searchDir.mkdirs();
        tmpDir.mkdirs();
    }

    public File getTilesDir() { return tilesDir; }
    public File getRoutingDir() { return routingDir; }
    public File getSearchDir() { return searchDir; }

    public long getAvailableStorageBytes() {
        try {
            ensureDirs();
            StatFs stats = new StatFs(rootDir.getAbsolutePath());
            return stats.getAvailableBytes();
        } catch (Exception e) {
            return 0L;
        }
    }

    public List<File> listValidTileFiles() {
        List<File> out = new ArrayList<>();
        File[] files = tilesDir.listFiles((dir, name) -> name.endsWith(".pmtiles"));
        if (files != null) {
            for (File f : files) {
                if (hasMagic(f, new byte[]{'P', 'M', 'T', 'i', 'l', 'e', 's', 3})) out.add(f);
            }
        }
        return out;
    }

    public List<File> listValidSearchFiles() {
        List<File> out = new ArrayList<>();
        File[] files = searchDir.listFiles((dir, name) -> name.endsWith(".db"));
        if (files != null) {
            for (File f : files) {
                if (hasMagic(f, "SQLite format 3".getBytes(StandardCharsets.US_ASCII))) out.add(f);
            }
        }
        return out;
    }

    public List<File> listValidRoutingFiles() {
        List<File> out = new ArrayList<>();
        File[] files = routingDir.listFiles((dir, name) -> name.endsWith(".rd5"));
        if (files != null) {
            for (File f : files) {
                if (f.length() > 1024) out.add(f);
            }
        }
        return out;
    }

    public JSONObject getStatusJson() {
        JSONObject status = new JSONObject();
        try {
            status.put("availableBytes", getAvailableStorageBytes());
            status.put("installedBytes", directorySize(tilesDir) + directorySize(routingDir) + directorySize(searchDir));
            status.put("tileCount", listValidTileFiles().size());
            status.put("routingCount", listValidRoutingFiles().size());
            status.put("searchCount", listValidSearchFiles().size());
            status.put("packages", readInstalledPackages());
        } catch (JSONException ignored) {}
        return status;
    }

    public void pauseDownload(String packageId) {
        AtomicBoolean flag = cancelFlags.get(packageId);
        if (flag != null) flag.set(true);
    }

    public void startPackageDownload(String packageJsonSpec) {
        executor.execute(() -> {
            String packageId = "unknown";
            try {
                JSONObject pkg = new JSONObject(packageJsonSpec);
                packageId = pkg.getString("id");
                String version = pkg.optString("version", "1");
                long requiredBytes = pkg.optLong("installedSizeBytes", pkg.optLong("downloadSizeBytes", 0L));
                long available = getAvailableStorageBytes();
                if (requiredBytes > 0 && available < requiredBytes + SAFETY_BUFFER_BYTES) {
                    emit(packageId, "error", 0, requiredBytes,
                            "Not enough free storage. Need at least " + formatMb(requiredBytes + SAFETY_BUFFER_BYTES) + ".");
                    return;
                }

                JSONArray files = pkg.getJSONArray("files");
                long totalBytes = 0;
                for (int i = 0; i < files.length(); i++) {
                    totalBytes += files.getJSONObject(i).optLong("sizeBytes", 0L);
                }

                AtomicBoolean cancelled = new AtomicBoolean(false);
                cancelFlags.put(packageId, cancelled);
                emit(packageId, "downloading", 0, totalBytes, "Starting download...");

                List<File> stagedFiles = new ArrayList<>();
                List<File> targetFiles = new ArrayList<>();
                List<String> installedRelativePaths = new ArrayList<>();
                long completedBefore = 0;

                for (int i = 0; i < files.length(); i++) {
                    JSONObject fSpec = files.getJSONObject(i);
                    String kind = fSpec.getString("kind"); // "tiles" | "routing" | "search"
                    String filename = sanitizeFilename(fSpec.getString("filename"));
                    String url = fSpec.getString("url");
                    String expectedSha256 = fSpec.optString("sha256", "").toLowerCase(Locale.US);
                    long expectedSize = fSpec.optLong("sizeBytes", 0L);

                    File targetDir = dirForKind(kind);
                    File partFile = new File(tmpDir, packageId + "_" + filename + ".part");
                    File targetFile = new File(targetDir, filename);

                    downloadWithResume(packageId, url, partFile, expectedSize, completedBefore, totalBytes, cancelled);
                    if (cancelled.get()) {
                        emit(packageId, "paused", completedBefore + partFile.length(), totalBytes, "Download paused.");
                        return;
                    }

                    if (!expectedSha256.isEmpty()) {
                        emit(packageId, "verifying", completedBefore + partFile.length(), totalBytes, "Verifying " + filename + "...");
                        String actualSha256 = sha256Hex(partFile);
                        if (!expectedSha256.equals(actualSha256)) {
                            partFile.delete();
                            emit(packageId, "error", completedBefore, totalBytes,
                                    "Corrupt download detected for " + filename + " (SHA-256 mismatch). Please retry.");
                            return;
                        }
                    }

                    completedBefore += partFile.length();
                    stagedFiles.add(partFile);
                    targetFiles.add(targetFile);
                    installedRelativePaths.add(kind + "/" + filename);
                }

                // Atomic swap into final directories
                for (int i = 0; i < stagedFiles.size(); i++) {
                    File staged = stagedFiles.get(i);
                    File target = targetFiles.get(i);
                    File backup = new File(target.getParentFile(), target.getName() + ".bak");
                    if (backup.exists()) backup.delete();
                    if (target.exists() && !target.renameTo(backup)) {
                        target.delete();
                    }
                    if (!staged.renameTo(target)) {
                        if (backup.exists()) backup.renameTo(target);
                        throw new IOException("Atomic install failed for " + target.getName());
                    }
                    if (backup.exists()) backup.delete();
                }

                recordInstalledPackage(packageId, version, pkg.optString("name", packageId),
                        completedBefore, installedRelativePaths);
                emit(packageId, "installed", completedBefore, Math.max(totalBytes, completedBefore), "Installed and verified.");
                if (listener != null) listener.onInstalledChanged();
            } catch (Exception e) {
                Log.e(TAG, "Offline package download failed for " + packageId, e);
                emit(packageId, "error", 0, 0, e.getMessage() != null ? e.getMessage() : "Download failed.");
            } finally {
                cancelFlags.remove(packageId);
            }
        });
    }

    public boolean deletePackage(String packageId) {
        pauseDownload(packageId);
        try {
            JSONArray installed = readInstalledPackages();
            JSONArray kept = new JSONArray();
            boolean removed = false;
            for (int i = 0; i < installed.length(); i++) {
                JSONObject item = installed.getJSONObject(i);
                if (packageId.equals(item.optString("id"))) {
                    JSONArray paths = item.optJSONArray("files");
                    if (paths != null) {
                        for (int j = 0; j < paths.length(); j++) {
                            File f = new File(rootDir, paths.getString(j));
                            if (f.exists()) f.delete();
                        }
                    }
                    removed = true;
                } else {
                    kept.put(item);
                }
            }
            // Clean up any partial files for this package
            File[] parts = tmpDir.listFiles((d, name) -> name.startsWith(packageId + "_"));
            if (parts != null) for (File p : parts) p.delete();
            writeInstalledPackages(kept);
            if (removed && listener != null) listener.onInstalledChanged();
            return removed;
        } catch (Exception e) {
            Log.e(TAG, "Failed to delete package " + packageId, e);
            return false;
        }
    }

    private void downloadWithResume(String packageId, String spec, File partFile, long expectedSize,
                                    long completedBefore, long totalBytes, AtomicBoolean cancelled) throws IOException {
        URL url = new URL(spec);
        if (!"https".equalsIgnoreCase(url.getProtocol())) {
            throw new IOException("Offline map downloads require HTTPS.");
        }
        long existing = partFile.exists() ? partFile.length() : 0L;
        if (expectedSize > 0 && existing == expectedSize) {
            return;
        }
        if (expectedSize > 0 && existing > expectedSize) {
            partFile.delete();
            existing = 0L;
        }

        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(30000);
        conn.setRequestProperty("User-Agent", "AndysDevStudio-RouteWeather-Android/0.33");
        if (existing > 0) {
            conn.setRequestProperty("Range", "bytes=" + existing + "-");
        }
        try {
            int status = conn.getResponseCode();
            boolean append = (status == 206 && existing > 0);
            if (status == 200) {
                existing = 0L;
            } else if (status != 206) {
                throw new IOException("Map server returned HTTP " + status);
            }

            try (InputStream in = new BufferedInputStream(conn.getInputStream(), 32768);
                 FileOutputStream out = new FileOutputStream(partFile, append)) {
                byte[] buf = new byte[32768];
                long current = existing;
                long lastNotify = 0L;
                int n;
                while ((n = in.read(buf)) != -1) {
                    if (cancelled.get()) return;
                    out.write(buf, 0, n);
                    current += n;
                    long now = System.currentTimeMillis();
                    if (now - lastNotify >= 350) {
                        lastNotify = now;
                        emit(packageId, "downloading", completedBefore + current, totalBytes,
                                "Downloading " + formatMb(completedBefore + current) + " / " + formatMb(totalBytes));
                    }
                }
                out.flush();
            }
        } finally {
            conn.disconnect();
        }
    }

    private File dirForKind(String kind) throws IOException {
        if ("tiles".equals(kind)) return tilesDir;
        if ("routing".equals(kind)) return routingDir;
        if ("search".equals(kind)) return searchDir;
        throw new IOException("Unknown offline package file kind: " + kind);
    }

    private static String sanitizeFilename(String name) throws IOException {
        if (name == null || name.isEmpty() || name.contains("/") || name.contains("\\") || name.contains("..")) {
            throw new IOException("Invalid package filename: " + name);
        }
        return name;
    }

    private static boolean hasMagic(File file, byte[] magic) {
        if (!file.isFile() || file.length() < magic.length) return false;
        try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
            byte[] head = new byte[magic.length];
            raf.readFully(head);
            for (int i = 0; i < magic.length; i++) {
                if (head[i] != magic[i]) return false;
            }
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    private static String sha256Hex(File file) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new BufferedInputStream(new FileInputStream(file), 65536)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) != -1) md.update(buf, 0, n);
        }
        byte[] digest = md.digest();
        StringBuilder sb = new StringBuilder(digest.length * 2);
        for (byte b : digest) sb.append(String.format(Locale.US, "%02x", b & 0xFF));
        return sb.toString();
    }

    private JSONArray readInstalledPackages() {
        if (!installedFile.isFile()) return new JSONArray();
        try (FileInputStream in = new FileInputStream(installedFile);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
            return new JSONArray(out.toString(StandardCharsets.UTF_8.name()));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    private void recordInstalledPackage(String id, String version, String name, long sizeBytes, List<String> files) throws Exception {
        JSONArray existing = readInstalledPackages();
        JSONArray next = new JSONArray();
        for (int i = 0; i < existing.length(); i++) {
            JSONObject item = existing.getJSONObject(i);
            if (!id.equals(item.optString("id"))) next.put(item);
        }
        JSONObject entry = new JSONObject();
        entry.put("id", id);
        entry.put("version", version);
        entry.put("name", name);
        entry.put("installedBytes", sizeBytes);
        entry.put("installedAt", System.currentTimeMillis());
        entry.put("files", new JSONArray(files));
        next.put(entry);
        writeInstalledPackages(next);
    }

    private void writeInstalledPackages(JSONArray array) throws IOException {
        File tmp = new File(rootDir, "installed.json.tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(array.toString().getBytes(StandardCharsets.UTF_8));
        }
        if (installedFile.exists()) installedFile.delete();
        if (!tmp.renameTo(installedFile)) {
            throw new IOException("Could not update installed.json");
        }
    }

    private static long directorySize(File dir) {
        long sum = 0L;
        File[] files = dir.listFiles();
        if (files != null) for (File f : files) if (f.isFile()) sum += f.length();
        return sum;
    }

    private static String formatMb(long bytes) {
        return String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024.0));
    }

    private void emit(String packageId, String state, long downloaded, long total, String message) {
        if (listener != null) listener.onProgress(packageId, state, downloaded, total, message);
    }

    public void shutdown() {
        for (AtomicBoolean flag : cancelFlags.values()) flag.set(true);
        executor.shutdownNow();
    }
}
