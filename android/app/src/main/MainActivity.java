package com.andysdevstudio.routeweather;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.hardware.GeomagneticField;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Base64;
import android.util.Log;
import android.view.Surface;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.util.Arrays;
import java.util.HashSet;
import java.util.HashMap;
import java.util.Map;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.HttpsURLConnection;

public final class MainActivity extends Activity implements SensorEventListener {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final int LOCATION_REQUEST = 12;
    private static final int RESPONSE_LIMIT = 12 * 1024 * 1024;
    private static final Set<String> PROVIDERS = new HashSet<>(Arrays.asList(
        "api.weather.gov",
        "cwwp2.dot.ca.gov", "quickmap.dot.ca.gov", "mesonet.agron.iastate.edu", "opengeo.ncep.noaa.gov",
        "tiles.openfreemap.org", "services3.arcgis.com", "services.arcgis.com",
        "az511.com", "iowa-atms.cloud-q-free.com", "mn.carsprogram.org",
        "filter.ritis.org", "511wi.gov", "traveler.modot.org", "storage.googleapis.com",
        "ks.carsprogram.org", "wzdx.e-dot.com", "511.idaho.gov", "in.carsprogram.org",
        "api.mdottraffic.com", "travelfiles.dot.nd.gov", "api.depot.fdot.gov",
        "spatial.tdot.tn.gov", "data.wsdot.wa.gov"
    ));

    private final ExecutorService requests = Executors.newFixedThreadPool(6);
    private final float[] rotation = new float[9];
    private WebView web;
    private SensorManager sensors;
    private Sensor compass;
    private boolean compassEnabled;
    private boolean resumed;
    private float declination;
    private boolean hasDeclination;
    private long lastHeadingAt;
    private GeolocationPermissions.Callback locationCallback;
    private boolean askingForLocation;
    private final Handler locationHandler = new Handler(Looper.getMainLooper());
    private final Map<Integer, LocationRequest> locations = new HashMap<>();
    private TextToSpeech voiceEngine;
    private boolean voiceReady;
    private String pendingVoice;
    private String activeUtterance;
    private long utteranceSequence;
    private AudioFocusRequest voiceFocus;
    private final List<String> fallbackVoiceEngines = new ArrayList<>();

    private void notifyVoice(String event) {
        if (web != null) web.evaluateJavascript("window.routeWeatherSpeechEvent?.(" + JSONObject.quote(event) + ")", null);
    }

    private void releaseVoiceFocus() {
        if (voiceFocus != null) {
            AudioFocusRequest previous = voiceFocus;
            voiceFocus = null;
            getSystemService(AudioManager.class).abandonAudioFocusRequest(previous);
        }
    }

    private void stopVoice() {
        pendingVoice = null;
        activeUtterance = null;
        if (voiceReady) voiceEngine.stop();
        releaseVoiceFocus();
    }

    private void finishVoice(String id, String event) {
        runOnUiThread(() -> {
            if (!id.equals(activeUtterance)) return;
            activeUtterance = null;
            releaseVoiceFocus();
            notifyVoice(event);
        });
    }

    private void voiceUnavailable(String detail) {
        Log.w("RouteWeatherVoice", detail);
        if (voiceEngine != null) voiceEngine.shutdown();
        voiceEngine = null;
        if (!fallbackVoiceEngines.isEmpty() && pendingVoice != null) {
            startVoice(fallbackVoiceEngines.remove(0));
        } else {
            pendingVoice = null;
            notifyVoice("error");
        }
    }

    private void startVoice(String engineName) {
        TextToSpeech.OnInitListener listener = result -> new Handler(Looper.getMainLooper()).post(() -> {
            if (voiceEngine == null || web == null) return;
            if (engineName == null) {
                fallbackVoiceEngines.clear();
                for (TextToSpeech.EngineInfo engine : voiceEngine.getEngines()) {
                    if (!engine.name.equals(voiceEngine.getDefaultEngine())) fallbackVoiceEngines.add(engine.name);
                }
            }
            if (result != TextToSpeech.SUCCESS) {
                voiceUnavailable("Could not initialize speech engine");
                return;
            }
            voiceEngine.setLanguage(Locale.US);
            Voice localEnglish = null;
            Set<Voice> voices = voiceEngine.getVoices();
            if (voices != null) for (Voice voice : voices) {
                if (!voice.isNetworkConnectionRequired() && "en".equals(voice.getLocale().getLanguage())
                    && (voice.getFeatures() == null || !voice.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED))
                    && (localEnglish == null || Locale.US.equals(voice.getLocale()))) localEnglish = voice;
            }
            if (localEnglish == null || voiceEngine.setVoice(localEnglish) != TextToSpeech.SUCCESS) {
                voiceUnavailable("No usable offline English voice in this engine");
                return;
            }
            voiceReady = true;
            voiceEngine.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) {
                    runOnUiThread(() -> { if (id.equals(activeUtterance)) notifyVoice("start"); });
                }
                @Override public void onDone(String id) { finishVoice(id, "done"); }
                @Override public void onError(String id) {
                    Log.w("RouteWeatherVoice", "Speech engine could not play utterance");
                    finishVoice(id, "error");
                }
            });
            String prompt = pendingVoice;
            pendingVoice = null;
            if (prompt != null) speakVoice(prompt);
        });
        voiceEngine = engineName == null ? new TextToSpeech(this, listener) : new TextToSpeech(this, listener, engineName);
    }

    private void speakVoice(String prompt) {
        if (!resumed || web == null || prompt == null || prompt.trim().isEmpty() || prompt.length() > 600) return;
        if (!voiceReady) {
            pendingVoice = prompt;
            if (voiceEngine == null) startVoice(null);
            return;
        }
        stopVoice();
        AudioAttributes attributes = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
        voiceEngine.setAudioAttributes(attributes);
        voiceFocus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(attributes)
            .setOnAudioFocusChangeListener(change -> { if (change < 0) stopVoice(); }).build();
        if (getSystemService(AudioManager.class).requestAudioFocus(voiceFocus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            Log.w("RouteWeatherVoice", "Audio focus was unavailable");
            releaseVoiceFocus();
            return;
        }
        activeUtterance = "route-direction-" + (++utteranceSequence);
        if (voiceEngine.speak(prompt, TextToSpeech.QUEUE_FLUSH, null, activeUtterance) != TextToSpeech.SUCCESS) {
            stopVoice();
            notifyVoice("error");
        }
    }

    private final class LocationRequest implements LocationListener {
        final int id;
        final boolean watch;
        final long timeout;
        final long maximumAge;
        final Runnable deadline = () -> fail(3, "Android location timed out.");

        LocationRequest(int id, boolean watch, long timeout, long maximumAge) {
            this.id = id;
            this.watch = watch;
            this.timeout = Math.max(1000, Math.min(timeout, 120000));
            this.maximumAge = Math.max(0, maximumAge);
        }

        void begin() {
            LocationManager manager = getSystemService(LocationManager.class);
            boolean listening = false;
            Location newest = null;
            for (String provider : Arrays.asList(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
                try {
                    if (!manager.isProviderEnabled(provider)) continue;
                    manager.requestLocationUpdates(provider, 1000, 0, this, Looper.getMainLooper());
                    listening = true;
                    Location last = manager.getLastKnownLocation(provider);
                    if (last != null && (newest == null || last.getElapsedRealtimeNanos() > newest.getElapsedRealtimeNanos())) newest = last;
                } catch (SecurityException | IllegalArgumentException ignored) {}
            }
            if (!listening) {
                fail(2, "Enable location services and try again.");
                return;
            }
            locationHandler.postDelayed(deadline, timeout);
            if (newest != null && maximumAge > 0
                && (SystemClock.elapsedRealtimeNanos() - newest.getElapsedRealtimeNanos()) / 1000000 <= maximumAge) {
                onLocationChanged(newest);
            }
        }

        @Override public void onLocationChanged(Location fix) {
            if (locations.get(id) != this) return;
            locationHandler.removeCallbacks(deadline);
            try {
                JSONObject coords = new JSONObject()
                    .put("latitude", fix.getLatitude()).put("longitude", fix.getLongitude())
                    .put("accuracy", fix.getAccuracy())
                    .put("altitude", fix.hasAltitude() ? fix.getAltitude() : JSONObject.NULL)
                    .put("heading", fix.hasBearing() ? fix.getBearing() : JSONObject.NULL)
                    .put("speed", fix.hasSpeed() ? fix.getSpeed() : JSONObject.NULL);
                JSONObject position = new JSONObject().put("coords", coords).put("timestamp", fix.getTime());
                if (!watch) stopLocation(id);
                replyLocation(id, position.toString(), "null");
            } catch (org.json.JSONException error) {
                fail(2, "Android returned an invalid location.");
            }
        }

        void fail(int code, String message) {
            stopLocation(id);
            replyLocation(id, "null", "{\"code\":" + code + ",\"message\":" + JSONObject.quote(message) + "}");
        }

        @Override public void onStatusChanged(String provider, int status, Bundle extras) {}
        @Override public void onProviderEnabled(String provider) {}
        @Override public void onProviderDisabled(String provider) {
            LocationManager manager = getSystemService(LocationManager.class);
            if (!manager.isProviderEnabled(LocationManager.GPS_PROVIDER)
                && !manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                fail(2, "Enable location services and try again.");
            }
        }
    }

    private void replyLocation(int id, String position, String error) {
        if (web != null) web.evaluateJavascript("window.routeWeatherLocation(" + id + "," + position + "," + error + ")", null);
    }

    private void stopLocation(int id) {
        LocationRequest request = locations.remove(id);
        if (request != null) {
            locationHandler.removeCallbacks(request.deadline);
            getSystemService(LocationManager.class).removeUpdates(request);
        }
    }

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        sensors = getSystemService(SensorManager.class);
        compass = sensors.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setGeolocationEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setUserAgentString(web.getSettings().getUserAgentString()+" RouteWeatherAndroid/0.1");
        web.addJavascriptInterface(new Bridge(), "AndroidRoute");
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!isLocal(uri)) return null;
                String name = uri.getPath();
                if (name == null || name.equals("/")) name = "/index.html";
                try {
                    return new WebResourceResponse(assetType(name), "UTF-8", getAssets().open(name.substring(1)));
                } catch (Exception ignored) {
                    return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", java.util.Collections.emptyMap(), null);
                }
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isLocal(uri)) return false;
                if (request.isForMainFrame() && "https".equals(uri.getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
                    catch (android.content.ActivityNotFoundException ignored) {}
                }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (!ORIGIN.equals(origin)) {
                    callback.invoke(origin, false, false);
                } else if (hasLocation()) {
                    callback.invoke(origin, true, false);
                } else {
                    locationCallback = callback;
                    requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION}, LOCATION_REQUEST);
                }
            }
        });
        setContentView(web);
        if (android.os.Build.VERSION.SDK_INT >= 35) {
            web.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets safe = insets.getInsets(android.view.WindowInsets.Type.systemBars()
                    | android.view.WindowInsets.Type.displayCutout() | android.view.WindowInsets.Type.ime());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
                return android.view.WindowInsets.CONSUMED;
            });
        }
        web.loadUrl(ORIGIN + "/index.html");
    }

    private static boolean isLocal(Uri uri) {
        return "https".equals(uri.getScheme()) && "appassets.androidplatform.net".equals(uri.getHost())
            && (uri.getPort() == -1 || uri.getPort() == 443);
    }

    private boolean hasLocation() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == LOCATION_REQUEST && locationCallback != null) {
            locationCallback.invoke(ORIGIN, hasLocation(), false);
            locationCallback = null;
        }
        if (code == LOCATION_REQUEST && askingForLocation) {
            askingForLocation = false;
            for (LocationRequest request : new java.util.ArrayList<>(locations.values())) {
                if (hasLocation()) request.begin();
                else request.fail(1, "Allow location access in Android settings.");
            }
        }
    }

    private static String assetType(String name) {
        if (name.endsWith(".css")) return "text/css";
        if (name.endsWith(".js") || name.endsWith(".mjs")) return "application/javascript";
        if (name.endsWith(".svg")) return "image/svg+xml";
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".json")) return "application/json";
        return "text/html";
    }

    private boolean wifiConnected() {
        ConnectivityManager manager = getSystemService(ConnectivityManager.class);
        NetworkCapabilities network = manager.getNetworkCapabilities(manager.getActiveNetwork());
        return network != null && network.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
    }

    private final class Bridge {
        @JavascriptInterface public void speakDirections(String text) { runOnUiThread(() -> speakVoice(text)); }
        @JavascriptInterface public void stopDirections() { runOnUiThread(() -> stopVoice()); }
        @JavascriptInterface public void fetch(int id, String spec, String accept, boolean wifiOnly) {
            if (id < 0 || spec.length() > 4096) return;
            requests.execute(() -> fetchProvider(id, spec, accept, wifiOnly));
        }
        @JavascriptInterface public boolean wifi() { return wifiConnected(); }
        @JavascriptInterface public String serviceOrigin() { return BuildConfig.SERVICE_ORIGIN; }
        @JavascriptInterface public void locationStart(int id, boolean watch, int timeout, int maximumAge) {
            runOnUiThread(() -> {
                if (web == null) return;
                stopLocation(id);
                LocationRequest request = new LocationRequest(id, watch, timeout, maximumAge);
                locations.put(id, request);
                if (hasLocation()) request.begin();
                else if (!askingForLocation) {
                    askingForLocation = true;
                    requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION}, LOCATION_REQUEST);
                }
            });
        }
        @JavascriptInterface public void locationStop(int id) { runOnUiThread(() -> stopLocation(id)); }
        @JavascriptInterface public void openLocationSettings() {
            runOnUiThread(() -> startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", getPackageName(), null))));
        }
        @JavascriptInterface public boolean hasCompass() { return compass != null; }
        @JavascriptInterface public void driving(boolean enabled) {
            runOnUiThread(() -> {
                compassEnabled = enabled;
                if (enabled) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                updateCompassRegistration();
            });
        }
        @JavascriptInterface public void compassPosition(double lat, double lon, double altitude) {
            if (!hasLocation() || !Double.isFinite(lat) || !Double.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
            runOnUiThread(() -> {
                declination = new GeomagneticField((float) lat, (float) lon,
                    Double.isFinite(altitude) ? (float) altitude : 0, System.currentTimeMillis()).getDeclination();
                hasDeclination = true;
            });
        }
    }

    private void fetchProvider(int id, String spec, String accept, boolean wifiOnly) {
        HttpsURLConnection connection = null;
        try {
            URL url = new URL(spec);
            String host = url.getHost().toLowerCase(Locale.ROOT);
            boolean studio = ("https://" + host).equalsIgnoreCase(BuildConfig.SERVICE_ORIGIN)
                && url.getPath().startsWith("/app-api/");
            if (!"https".equals(url.getProtocol()) || (url.getPort() != -1 && url.getPort() != 443)
                || url.getUserInfo() != null || !(studio || PROVIDERS.contains(host))) throw new IllegalArgumentException();
            if (wifiOnly && !wifiConnected()) throw new IllegalStateException();
            connection = (HttpsURLConnection) url.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(15000);
            connection.setRequestProperty("User-Agent", "AndysDevStudio-RouteWeather-Android/0.1");
            connection.setRequestProperty("Accept", accept);
            final int httpStatus = connection.getResponseCode();
            String type = connection.getContentType();
            if (httpStatus < 200 || httpStatus >= 300) {
                if (studio && type != null && type.startsWith("application/json") && httpStatus >= 400) {
                    try (InputStream input = connection.getErrorStream()) {
                        if (input != null) {
                            ByteArrayOutputStream body = new ByteArrayOutputStream();
                            byte[] buffer = new byte[1024];
                            while (body.size() < 8192) {
                                int count = input.read(buffer, 0, Math.min(buffer.length, 8192 - body.size()));
                                if (count < 0) break;
                                body.write(buffer, 0, count);
                            }
                            deliver(id, httpStatus, type, Base64.encodeToString(body.toByteArray(), Base64.NO_WRAP));
                            return;
                        }
                    }
                }
                deliver(id, httpStatus >= 400 ? httpStatus : 502, "text/plain", "");
                return;
            }
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                for (int count; (count = input.read(buffer)) != -1;) {
                    if (output.size() + count > RESPONSE_LIMIT) throw new IllegalStateException();
                    output.write(buffer, 0, count);
                }
                deliver(id, 200, type == null ? "application/octet-stream" : type,
                    Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP));
            }
        } catch (Exception error) {
            deliver(id, 502, "text/plain", "");
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void deliver(int id, int status, String type, String base64) {
        runOnUiThread(() -> sendChunk(id, status, type, base64, 0));
    }

    private void sendChunk(int id, int status, String type, String base64, int offset) {
        if (web == null) return;
        int end = Math.min(offset + 48000, base64.length());
        boolean last = end == base64.length();
        web.evaluateJavascript("window.routeWeatherReply(" + id + "," + status + ","
            + JSONObject.quote(type) + "," + JSONObject.quote(base64.substring(offset, end))
            + "," + last + ")", result -> {
            if (!last && "true".equals(result)) sendChunk(id, status, type, base64, end);
        });
    }

    private void updateCompassRegistration() {
        sensors.unregisterListener(this);
        if (compassEnabled && resumed && compass != null) sensors.registerListener(this, compass, 100000);
    }

    @Override public void onSensorChanged(SensorEvent event) {
        long now = android.os.SystemClock.elapsedRealtime();
        if (!hasDeclination || event.accuracy == SensorManager.SENSOR_STATUS_UNRELIABLE || now - lastHeadingAt < 90) return;
        lastHeadingAt = now;
        SensorManager.getRotationMatrixFromVector(rotation, event.values);
        int display = getWindowManager().getDefaultDisplay().getRotation();
        int axis = display == Surface.ROTATION_90 ? 0 : display == Surface.ROTATION_270 ? 0 : 1;
        int sign = display == Surface.ROTATION_180 || display == Surface.ROTATION_270 ? -1 : 1;
        float east = sign * rotation[axis], north = sign * rotation[axis + 3];
        if (Math.hypot(east, north) < .5) { east = -rotation[2]; north = -rotation[5]; }
        if (Math.hypot(east, north) < .3 || web == null) return;
        double course = (Math.toDegrees(Math.atan2(east, north)) + declination + 360) % 360;
        web.evaluateJavascript("window.routeWeatherCompass?.(" + course + ")", null);
    }

    @Override public void onAccuracyChanged(Sensor sensor, int accuracy) {}
    @Override protected void onResume() { super.onResume(); resumed = true; web.onResume(); updateCompassRegistration(); }
    @Override protected void onPause() { resumed = false; stopVoice(); updateCompassRegistration(); web.onPause(); super.onPause(); }
    @Override protected void onDestroy() {
        stopVoice();
        if (voiceEngine != null) {
            voiceEngine.shutdown();
            voiceEngine = null;
        }
        for (int id : new java.util.ArrayList<>(locations.keySet())) stopLocation(id);
        sensors.unregisterListener(this);
        requests.shutdownNow();
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }
}
