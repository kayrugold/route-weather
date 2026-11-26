package com.andysdevstudio.routeweather;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
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
import android.speech.RecognizerIntent;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.util.Base64;
import android.util.Log;
import android.view.Gravity;
import android.view.Surface;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONObject;

import com.andysdevstudio.routeweather.audio.AtlasAudioManager;
import com.andysdevstudio.routeweather.audio.AtlasVoiceController;
import com.andysdevstudio.routeweather.offline.OfflineEngine;
import com.andysdevstudio.routeweather.offline.OfflinePackageManager;

import java.io.ByteArrayInputStream;
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
    private static final int DESTINATION_SPEECH_REQUEST = 13;
    private static final int AUDIO_PERMISSION_REQUEST = 14;
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
    private final ExecutorService plannerRequests = Executors.newFixedThreadPool(2);
    private final float[] rotation = new float[9];
    private WebView web;
    private FrameLayout rootLayout;
    private FrameLayout ytContainer;
    private WebView ytWeb;
    private boolean ytEnabled;
    private boolean ytExpanded;
    private boolean ytBrowseMode;
    private int ytBottomCssPx = 132;
    private final Runnable ytSyncTask = new Runnable() {
        @Override public void run() {
            if (!ytEnabled || ytWeb == null) return;
            syncYtState();
            locationHandler.postDelayed(this, 2000L);
        }
    };
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
    private AtlasAudioManager audioManager;
    private AtlasVoiceController voiceController;
    private boolean pendingListenAfterGrant;
    private boolean pendingHandsFreeAfterGrant;
    private String pendingExternalAction;
    private String pendingExternalValue;
    private OfflineEngine offlineEngine;

    private void notifyVoice(String event) {
        if (web != null) web.evaluateJavascript("window.routeWeatherSpeechEvent?.(" + JSONObject.quote(event) + ")", null);
    }

    private void duckYtMedia(boolean duck) {
        if (!ytEnabled || ytWeb == null) return;
        String js = duck
            ? "(function(){var v=document.querySelector('video');if(v&&!v.paused){if(window.__rwSavedVol==null)window.__rwSavedVol=v.volume;v.volume=Math.min(v.volume,0.22);}})()"
            : "(function(){var v=document.querySelector('video');if(v&&window.__rwSavedVol!=null){v.volume=window.__rwSavedVol;window.__rwSavedVol=null;}})()";
        ytWeb.evaluateJavascript(js, null);
    }

    private void stopVoice() {
        if (audioManager != null) audioManager.stopAll();
    }

    private void speakVoice(String prompt) {
        if (audioManager != null) {
            audioManager.speak(prompt, AtlasAudioManager.PRIORITY_NAVIGATION, "", false, false);
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
                    .put("altitudeAccuracy", fix.hasVerticalAccuracy() ? fix.getVerticalAccuracyMeters() : JSONObject.NULL)
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
        audioManager = new AtlasAudioManager(this, new AtlasAudioManager.Callbacks() {
            @Override public boolean isResumed() { return resumed && web != null; }
            @Override public void onSpeechEvent(String event, int priority, String key) {
                if (voiceController != null) {
                    if ("start".equals(event)) voiceController.setSuspendedForTts(true);
                    else if ("done".equals(event) || "error".equals(event)) voiceController.setSuspendedForTts(false);
                }
                runOnUiThread(() -> notifyVoice(event));
            }
            @Override public void onDuckMedia(boolean duck) {
                runOnUiThread(() -> duckYtMedia(duck));
            }
            @Override public void onPauseMedia() {
                runOnUiThread(() -> {
                    if (ytEnabled && ytWeb != null) runYtAction("pause");
                });
            }
        });
        voiceController = new AtlasVoiceController(this, new AtlasVoiceController.Callbacks() {
            @Override public boolean isResumed() { return resumed && web != null; }
            @Override public boolean hasRecordPermission() { return hasAudioPermission(); }
            @Override public void onStateChanged(String state, boolean handsFree) {
                runOnUiThread(() -> {
                    if (web != null) {
                        web.evaluateJavascript("window.atlasVoiceState?.(" + JSONObject.quote(state) + "," + handsFree + ")", null);
                    }
                });
            }
            @Override public void onTranscripts(String candidatesJson, boolean requireWakeWord) {
                runOnUiThread(() -> {
                    if (web != null) {
                        web.evaluateJavascript("window.atlasVoiceTranscript?.(" + candidatesJson + "," + requireWakeWord + ")", null);
                    }
                });
            }
            @Override public void onMediaAction(String action) {
                runOnUiThread(() -> {
                    if (web != null) {
                        web.evaluateJavascript("window.atlasExternalCommand?.(" + JSONObject.quote(action) + ",'')", null);
                    } else if (ytEnabled && ytWeb != null) {
                        if ("media_pause".equals(action)) runYtAction("pause");
                        else if ("media_play".equals(action)) runYtAction("toggle");
                        else if ("media_next".equals(action)) runYtAction("next");
                        else if ("media_prev".equals(action)) runYtAction("prev");
                    }
                });
            }
            @Override public void onDuckForListening(boolean duck) {
                runOnUiThread(() -> duckYtMedia(duck));
            }
        });
        captureNavigationIntent(getIntent(), false);
        offlineEngine = new OfflineEngine(this, new OfflinePackageManager.Listener() {
            @Override public void onProgress(String packageId, String state, long downloadedBytes, long totalBytes, String message) {
                runOnUiThread(() -> {
                    if (web == null) return;
                    try {
                        JSONObject ev = new JSONObject()
                            .put("packageId", packageId).put("state", state)
                            .put("downloadedBytes", downloadedBytes).put("totalBytes", totalBytes)
                            .put("message", message);
                        web.evaluateJavascript("window.routeWeatherOfflineEvent?.(" + ev.toString() + ")", null);
                    } catch (Exception ignored) {}
                });
            }
            @Override public void onInstalledChanged() {
                runOnUiThread(() -> {
                    if (web != null) web.evaluateJavascript("window.routeWeatherOfflineChanged?.()", null);
                });
            }
        });
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
                if (name.startsWith("/offline-tiles/") && offlineEngine != null) {
                    String[] parts = name.substring("/offline-tiles/".length()).replace(".mvt", "").split("/");
                    if (parts.length == 3) {
                        try {
                            int z = Integer.parseInt(parts[0]);
                            int x = Integer.parseInt(parts[1]);
                            int y = Integer.parseInt(parts[2]);
                            byte[] tile = offlineEngine.getVectorTile(z, x, y);
                            if (tile != null) {
                                return new WebResourceResponse("application/vnd.mapbox-vector-tile", null, new ByteArrayInputStream(tile));
                            }
                        } catch (Exception ignored) {}
                    }
                    return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", java.util.Collections.emptyMap(), null);
                }
                try {
                    return new WebResourceResponse(assetType(name), "UTF-8", getAssets().open(name.substring(1)));
                } catch (Exception ignored) {
                    return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", java.util.Collections.emptyMap(), null);
                }
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isLocal(uri)) return false;
                if (!request.isForMainFrame() && "https".equals(uri.getScheme())) return false;
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
        rootLayout = new FrameLayout(this);
        rootLayout.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(rootLayout);
        if (android.os.Build.VERSION.SDK_INT >= 35) {
            rootLayout.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets safe = insets.getInsets(android.view.WindowInsets.Type.systemBars()
                    | android.view.WindowInsets.Type.displayCutout() | android.view.WindowInsets.Type.ime());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
                return android.view.WindowInsets.CONSUMED;
            });
        }
        web.loadUrl(ORIGIN + "/index.html");
    }

    private void ensureYtWebView() {
        if (ytWeb != null || rootLayout == null) return;
        ytContainer = new FrameLayout(this);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor("#0e1318"));
        bg.setCornerRadius(14f * getResources().getDisplayMetrics().density);
        bg.setStroke((int) Math.max(1f, getResources().getDisplayMetrics().density), Color.parseColor("#4d7594"));
        ytContainer.setBackground(bg);
        ytContainer.setClipToOutline(true);
        ytContainer.setElevation(16f * getResources().getDisplayMetrics().density);

        ytWeb = new WebView(this);
        ytWeb.getSettings().setJavaScriptEnabled(true);
        ytWeb.getSettings().setDomStorageEnabled(true);
        ytWeb.getSettings().setMediaPlaybackRequiresUserGesture(false);
        ytWeb.getSettings().setDatabaseEnabled(true);
        ytWeb.getSettings().setUseWideViewPort(true);
        ytWeb.getSettings().setLoadWithOverviewMode(true);
        ytWeb.setBackgroundColor(Color.parseColor("#0e1318"));
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(ytWeb, true);
        ytWeb.setWebChromeClient(new WebChromeClient());
        ytWeb.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String host = uri != null ? uri.getHost() : null;
                if (host != null && (host.endsWith("youtube.com") || host.endsWith("youtu.be")
                        || host.endsWith("google.com") || host.endsWith("googleapis.com") || host.endsWith("gstatic.com"))) {
                    return false;
                }
                return true;
            }
            @Override public void onPageFinished(WebView view, String url) {
                applyYtViewMode();
                syncYtState();
            }
        });
        ytContainer.addView(ytWeb, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(1, 1);
        lp.gravity = Gravity.BOTTOM | Gravity.START;
        ytContainer.setAlpha(0f);
        ytContainer.setClickable(false);
        ytContainer.setFocusable(false);
        rootLayout.addView(ytContainer, lp);
        ytWeb.loadUrl("https://m.youtube.com");
    }

    private void applyYtViewMode() {
        if (ytWeb == null) return;
        boolean videoOnly = !ytBrowseMode;
        String js = "(function(){"
            + "var id='rw-yt-clean-css';var st=document.getElementById(id);"
            + "if(!st){st=document.createElement('style');st.id=id;document.head.appendChild(st);}"
            + "var onWatch=location.pathname.indexOf('/watch')===0;"
            + "if(!window.__rwPauseGuard){window.__rwPauseGuard=true;window.__rwLastTouch=0;"
            + "  document.addEventListener('pointerdown',function(){window.__rwLastTouch=Date.now();},true);"
            + "  var _op=HTMLMediaElement.prototype.pause;"
            + "  HTMLMediaElement.prototype.pause=function(){"
            + "    if(window.__rwAllowPause||(Date.now()-window.__rwLastTouch<450)){window.__rwAllowPause=false;return _op.apply(this,arguments);}"
            + "    return;"
            + "  };"
            + "}"
            + "var hideDrawer='drawer-layout-container,.ytmDrawerLayoutContainerHost,.ytmDrawerLayoutContainerDrawerLayout,ytm-pivot-bar-renderer{display:none!important}';"
            + "var keepVideo='video.html5-main-video,video{min-height:120px!important;min-width:200px!important}#movie_player,.html5-video-player,.html5-video-container{min-height:120px!important}';"
            + "if(" + videoOnly + "&&onWatch){"
            + "  st.textContent=hideDrawer+keepVideo+'ytm-mobile-topbar-renderer,ytm-slim-video-metadata-section-renderer,ytm-item-section-renderer,ytm-engagement-panel-section-list-renderer,ytm-comments-entry-point-header-renderer,.related-chips-slot-wrapper,.watch-below-the-player{display:none!important}'+"
            + "  'body,html{background:#000!important;overflow:hidden!important;height:100%!important;width:100%!important}'+"
            + "  '#player-container-id,.player-container,#movie_player,.html5-video-player,.html5-video-container{position:fixed!important;left:0!important;top:0!important;width:100vw!important;height:100vh!important;min-height:100vh!important;background:#000!important}'+"
            + "  'video.html5-main-video,video{position:fixed!important;left:0!important;top:0!important;width:100vw!important;height:100vh!important;min-height:100vh!important;object-fit:cover!important}';"
            + "}else{"
            + "  st.textContent=hideDrawer+keepVideo;"
            + "}"
            + "})()";
        ytWeb.evaluateJavascript(js, null);
    }

    private void layoutYtContainer() {
        if (ytContainer == null) return;
        float d = getResources().getDisplayMetrics().density;
        if (!ytEnabled || !ytExpanded) {
            // Keep full 240x135dp dimensions offscreen (translationX) so YouTube never sees height=0 and never auto-pauses audio!
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(Math.round(240 * d), Math.round(135 * d));
            lp.gravity = Gravity.BOTTOM | Gravity.START;
            ytContainer.setLayoutParams(lp);
            ytContainer.setTranslationX(4000f * d);
            ytContainer.setAlpha(0f);
            ytContainer.setClickable(false);
            ytContainer.setFocusable(false);
            return;
        }
        ytContainer.setTranslationX(0f);
        int w = rootLayout.getWidth() > 0 ? rootLayout.getWidth() : getResources().getDisplayMetrics().widthPixels;
        int h = rootLayout.getHeight() > 0 ? rootLayout.getHeight() : getResources().getDisplayMetrics().heightPixels;
        boolean landscape = w > h;
        int margin = Math.round(10 * d);
        int bottomMargin = Math.round((ytBottomCssPx + 22) * d);
        int leftClearance = Math.round(78 * d); // Keeps GPS target / + / - buttons visible on the left!
        FrameLayout.LayoutParams lp;
        if (landscape) {
            int panelW = Math.round(w * (ytBrowseMode ? 0.50f : 0.40f));
            int panelH = ytBrowseMode
                ? Math.max(Math.round(180 * d), h - bottomMargin - Math.round(64 * d))
                : Math.min(Math.round(190 * d), Math.round(panelW * 9f / 16f));
            lp = new FrameLayout.LayoutParams(panelW, panelH);
            lp.gravity = Gravity.BOTTOM | Gravity.END;
            lp.rightMargin = margin;
            lp.bottomMargin = bottomMargin;
        } else {
            int panelW = Math.max(Math.round(220 * d), w - leftClearance - margin);
            int panelH = ytBrowseMode
                ? Math.min(Math.round(350 * d), Math.max(Math.round(250 * d), Math.round(h * 0.44f)))
                : Math.round(panelW * 9f / 16f);
            lp = new FrameLayout.LayoutParams(panelW, panelH);
            lp.gravity = Gravity.BOTTOM | Gravity.END;
            lp.rightMargin = margin;
            lp.bottomMargin = bottomMargin;
        }
        ytContainer.setLayoutParams(lp);
        ytContainer.setAlpha(1f);
        ytContainer.setClickable(true);
        ytContainer.setFocusable(true);
        ytContainer.bringToFront();
        applyYtViewMode();
    }

    private void syncYtState() {
        if (ytWeb == null || web == null) return;
        String js = "(function(){var v=document.querySelector('video');var t=(document.title||'YouTube').replace(/\\s*-\\s*YouTube$/i,'').trim()||'YouTube';return JSON.stringify({playing:Boolean(v&&!v.paused&&!v.ended),hasVideo:Boolean(v),title:t,url:location.href});})()";
        ytWeb.evaluateJavascript(js, raw -> {
            if (web == null || raw == null || "null".equals(raw)) return;
            try {
                String unquoted = new org.json.JSONTokener(raw).nextValue().toString();
                if (voiceController != null) {
                    try {
                        JSONObject st = new JSONObject(unquoted);
                        voiceController.updateMediaPlaybackState(st.optBoolean("playing", false));
                    } catch (Exception ignored) {}
                }
                web.evaluateJavascript("window.routeWeatherYtState?.(" + unquoted + ")", null);
            } catch (Exception ignored) {}
        });
    }

    private void runYtAction(String action) {
        if (ytWeb == null) return;
        String js;
        if ("toggle".equals(action)) {
            js = "(function(){"
                + "var p=document.getElementById('movie_player'),v=document.querySelector('video');"
                + "if(v&&!v.paused){"
                + "  window.__rwAllowPause=true;"
                + "  if(p&&typeof p.pauseVideo==='function')p.pauseVideo();"
                + "  if(!v.paused){window.__rwAllowPause=true;v.pause();}"
                + "  return;"
                + "}"
                + "if(p&&typeof p.playVideo==='function'){"
                + "  if(typeof p.unMute==='function')p.unMute();"
                + "  if(v)v.muted=false;"
                + "  p.playVideo();"
                + "  if(v)v.play().catch(function(){});"
                + "  return;"
                + "}"
                + "if(v){v.muted=false;v.play().catch(function(){});}"
                + "})()";
        } else if ("pause".equals(action)) {
            js = "(function(){window.__rwAllowPause=true;var p=document.getElementById('movie_player'),v=document.querySelector('video');if(p&&typeof p.pauseVideo==='function'){p.pauseVideo();}if(v&&!v.paused){window.__rwAllowPause=true;v.pause();}})()";
        } else if ("next".equals(action)) {
            js = "(function(){"
                + "var btn=document.querySelector('button[aria-label*=\"Next\" i],a.ytp-next-button,.player-controls-middle button[aria-label*=\"Next\" i]');"
                + "if(btn){btn.click();return;}"
                + "var cur=(new URLSearchParams(location.search)).get('v')||'';"
                + "var links=Array.from(document.querySelectorAll('a[href*=\"/watch?v=\"]'));"
                + "for(var i=0;i<links.length;i++){"
                + "  try{var u=new URL(links[i].href,location.origin);var id=u.searchParams.get('v');"
                + "  if(id&&id!==cur){links[i].click();return;}}catch(e){}"
                + "}"
                + "})()";
        } else if ("prev".equals(action)) {
            js = "(function(){"
                + "var btn=document.querySelector('button[aria-label*=\"Previous\" i],a.ytp-prev-button');"
                + "if(btn&&!btn.disabled){btn.click();return;}"
                + "if(history.length>1){history.back();return;}"
                + "var v=document.querySelector('video');if(v){v.currentTime=0;}"
                + "})()";
        } else {
            syncYtState();
            return;
        }
        ytWeb.evaluateJavascript(js, r -> locationHandler.postDelayed(this::syncYtState, 350L));
    }

    private static boolean isLocal(Uri uri) {
        return "https".equals(uri.getScheme()) && "appassets.androidplatform.net".equals(uri.getHost())
            && (uri.getPort() == -1 || uri.getPort() == 443);
    }

    private boolean hasLocation() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasAudioPermission() {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    private void captureNavigationIntent(Intent intent, boolean dispatchNow) {
        if (intent == null) return;
        String action = intent.getStringExtra("atlas_action");
        String value = intent.getStringExtra("atlas_value");
        String feature = intent.getStringExtra("atlas_feature");
        String explicitDest = intent.getStringExtra("atlas_destination");

        if ((action == null || action.isEmpty()) && explicitDest != null && !explicitDest.trim().isEmpty()) {
            action = "destination";
            value = explicitDest.trim();
        } else if ((action == null || action.isEmpty()) && feature != null && !feature.trim().isEmpty()) {
            action = "feature";
            value = feature.trim();
        } else if ((action == null || action.isEmpty()) && Intent.ACTION_VIEW.equals(intent.getAction())) {
            Uri data = intent.getData();
            if (data != null) {
                String scheme = data.getScheme();
                String query = null;
                if ("google.navigation".equals(scheme) || "geo".equals(scheme)) {
                    query = data.getQueryParameter("q");
                    if (query == null || query.trim().isEmpty()) {
                        String ssp = data.getSchemeSpecificPart();
                        if (ssp != null) {
                            int qIdx = ssp.indexOf("q=");
                            if (qIdx >= 0) query = Uri.decode(ssp.substring(qIdx + 2).split("&")[0]);
                            else if (!ssp.startsWith("0,0")) query = ssp.split("\\?")[0];
                        }
                    }
                }
                if (query != null && !query.trim().isEmpty()) {
                    action = "destination";
                    value = query.trim();
                }
            }
        }
        if (action == null || action.trim().isEmpty()) return;
        String act = action.trim();
        String val = value == null ? "" : value.trim();
        if (dispatchNow && web != null) {
            web.evaluateJavascript("window.atlasExternalCommand?.(" + JSONObject.quote(act) + "," + JSONObject.quote(val) + ")", null);
        } else {
            pendingExternalAction = act;
            pendingExternalValue = val;
        }
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        captureNavigationIntent(intent, true);
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == AUDIO_PERMISSION_REQUEST) {
            boolean granted = hasAudioPermission();
            boolean listen = pendingListenAfterGrant;
            boolean hf = pendingHandsFreeAfterGrant;
            pendingListenAfterGrant = false;
            pendingHandsFreeAfterGrant = false;
            if (granted && voiceController != null) {
                if (hf) voiceController.setHandsFree(true);
                if (listen) voiceController.listenOnce(true);
            } else if (web != null) {
                web.evaluateJavascript("window.atlasVoiceState?.('denied',false)", null);
            }
            return;
        }
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

    private void sendDestinationSpeech(String transcript, String error) {
        if (web != null) web.evaluateJavascript("window.routeWeatherDestinationSpeech?.("
            + JSONObject.quote(transcript) + "," + JSONObject.quote(error) + ")", null);
    }

    private void requestDestinationSpeech() {
        stopVoice();
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_PROMPT, "Say a destination");
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        try {
            startActivityForResult(intent, DESTINATION_SPEECH_REQUEST);
        } catch (ActivityNotFoundException | SecurityException error) {
            sendDestinationSpeech("", "Speech recognition is unavailable. Type a destination instead.");
        }
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != DESTINATION_SPEECH_REQUEST) return;
        if (result != RESULT_OK) {
            sendDestinationSpeech("", "");
            return;
        }
        List<String> results = data == null ? null : data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
        String transcript = results == null || results.isEmpty() ? "" : results.get(0);
        sendDestinationSpeech(transcript, transcript == null || transcript.trim().isEmpty()
            ? "No destination heard. Try again or type it." : "");
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

    private boolean hasInternetConnection() {
        ConnectivityManager manager = getSystemService(ConnectivityManager.class);
        NetworkCapabilities network = manager.getNetworkCapabilities(manager.getActiveNetwork());
        return network != null
            && network.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            && network.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
    }

    private final class Bridge {
        @JavascriptInterface public void recognizeDestination() { runOnUiThread(MainActivity.this::requestDestinationSpeech); }
        @JavascriptInterface public void speakDirections(String text) { runOnUiThread(() -> speakVoice(text)); }
        @JavascriptInterface public void stopDirections() { runOnUiThread(() -> {
            if (audioManager != null) audioManager.stopFromPriority(AtlasAudioManager.PRIORITY_NAVIGATION);
        }); }
        @JavascriptInterface public void speakAudio(String text, int priority, String dedupeKey, boolean interrupt, boolean pauseMedia) {
            runOnUiThread(() -> {
                if (audioManager != null) audioManager.speak(text, priority, dedupeKey, interrupt, pauseMedia);
            });
        }
        @JavascriptInterface public void stopAudio(int minPriority) {
            runOnUiThread(() -> {
                if (audioManager != null) audioManager.stopFromPriority(minPriority);
            });
        }
        @JavascriptInterface public void routerListenOnce(boolean withTone) {
            runOnUiThread(() -> {
                if (voiceController == null) return;
                if (!hasAudioPermission()) {
                    pendingListenAfterGrant = true;
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, AUDIO_PERMISSION_REQUEST);
                    return;
                }
                voiceController.listenOnce(withTone);
            });
        }
        @JavascriptInterface public void routerToggleListen(boolean withTone) {
            runOnUiThread(() -> {
                if (voiceController == null) return;
                if (!hasAudioPermission()) {
                    pendingListenAfterGrant = true;
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, AUDIO_PERMISSION_REQUEST);
                    return;
                }
                voiceController.toggleDirectListen(withTone);
            });
        }
        @JavascriptInterface public void routerSetHandsFree(boolean enabled) {
            runOnUiThread(() -> {
                if (voiceController == null) return;
                if (enabled && !hasAudioPermission()) {
                    pendingHandsFreeAfterGrant = true;
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, AUDIO_PERMISSION_REQUEST);
                    return;
                }
                voiceController.setHandsFree(enabled);
            });
        }
        @JavascriptInterface public void routerPlayTone(String kind) {
            if (voiceController != null) voiceController.playTone(kind);
        }
        @JavascriptInterface public String routerConsumeExternalCommand() {
            if (pendingExternalAction == null || pendingExternalAction.isEmpty()) return "";
            try {
                String json = new JSONObject()
                    .put("action", pendingExternalAction)
                    .put("value", pendingExternalValue == null ? "" : pendingExternalValue)
                    .toString();
                pendingExternalAction = null;
                pendingExternalValue = null;
                return json;
            } catch (Exception ignored) {
                pendingExternalAction = null;
                pendingExternalValue = null;
                return "";
            }
        }
        @JavascriptInterface public void fetch(int id, String spec, String accept, boolean wifiOnly) {
            if (id < 0 || spec.length() > 4096) return;
            Uri target = Uri.parse(spec);
            boolean planner = (BuildConfig.SERVICE_ORIGIN + "/app-api/route").equals(spec.split("\\?",2)[0])
                || (BuildConfig.SERVICE_ORIGIN + "/app-api/search").equals(spec.split("\\?",2)[0]) && !"facilities".equals(target.getQueryParameter("mode"));
            (planner ? plannerRequests : requests).execute(() -> fetchProvider(id, spec, accept, wifiOnly));
        }
        @JavascriptInterface public boolean wifi() { return wifiConnected(); }
        @JavascriptInterface public boolean hasInternet() { return hasInternetConnection(); }
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
        @JavascriptInterface public String offlineStatus() {
            return offlineEngine != null ? offlineEngine.statusJson() : "{}";
        }
        @JavascriptInterface public String offlineSearch(String query, String mode, double lat, double lon, int limit) {
            if (offlineEngine == null) return "[]";
            Double nLat = Double.isFinite(lat) ? lat : null;
            Double nLon = Double.isFinite(lon) ? lon : null;
            return offlineEngine.searchJson(query, mode, nLat, nLon, limit);
        }
        @JavascriptInterface public String offlineFacilities(String kind, double west, double south, double east, double north, int offset) {
            return offlineEngine != null ? offlineEngine.facilitiesJson(kind, west, south, east, north, offset) : "{\"items\":[],\"total\":0,\"offset\":0}";
        }
        @JavascriptInterface public String offlineNearestRoad(double lat, double lon) {
            return offlineEngine != null ? offlineEngine.nearestRoadJson(lat, lon) : "{\"error\":\"Offline engine unavailable.\"}";
        }
        @JavascriptInterface public String offlineCorridors(String coords) {
            return offlineEngine != null ? offlineEngine.corridorsJson(coords) : "[]";
        }
        @JavascriptInterface public String offlineRoute(String coords, String profile) {
            return offlineEngine != null ? offlineEngine.routeJson(coords, profile) : "{\"error\":\"Offline engine unavailable.\"}";
        }
        @JavascriptInterface public void offlineRouteAsync(int reqId, String coords, String profile) {
            requests.execute(() -> {
                String json = offlineEngine != null
                    ? offlineEngine.routeJson(coords, profile)
                    : "{\"error\":\"Offline engine unavailable.\"}";
                runOnUiThread(() -> {
                    if (web != null) {
                        web.evaluateJavascript("window.routeWeatherOfflineRouteReply?.(" + reqId + "," + JSONObject.quote(json) + ")", null);
                    }
                });
            });
        }
        @JavascriptInterface public void offlineDownloadPackage(String packageJson) {
            if (offlineEngine != null) offlineEngine.getPackageManager().startPackageDownload(packageJson);
        }
        @JavascriptInterface public void offlinePauseDownload(String packageId) {
            if (offlineEngine != null) offlineEngine.getPackageManager().pauseDownload(packageId);
        }
        @JavascriptInterface public boolean offlineDeletePackage(String packageId) {
            return offlineEngine != null && offlineEngine.getPackageManager().deletePackage(packageId);
        }
        @JavascriptInterface public void offlineReload() {
            if (offlineEngine != null) offlineEngine.reloadInstalledData();
        }
        @JavascriptInterface public void ytSetEnabled(boolean enabled) {
            runOnUiThread(() -> {
                ytEnabled = enabled;
                locationHandler.removeCallbacks(ytSyncTask);
                if (enabled) {
                    ensureYtWebView();
                    layoutYtContainer();
                    locationHandler.postDelayed(ytSyncTask, 1200L);
                } else {
                    ytExpanded = false;
                    runYtAction("pause");
                    layoutYtContainer();
                }
            });
        }
        @JavascriptInterface public void ytSetExpanded(boolean expanded, int bottomCssPx) {
            runOnUiThread(() -> {
                if (bottomCssPx > 0) ytBottomCssPx = bottomCssPx;
                ytExpanded = expanded && ytEnabled;
                if (ytEnabled) ensureYtWebView();
                layoutYtContainer();
                if (ytEnabled) syncYtState();
            });
        }
        @JavascriptInterface public void ytSetBrowseMode(boolean browse) {
            runOnUiThread(() -> {
                ytBrowseMode = browse;
                if (ytEnabled) {
                    ensureYtWebView();
                    if (!ytExpanded) ytExpanded = true;
                    layoutYtContainer();
                    syncYtState();
                }
            });
        }
        @JavascriptInterface public void ytControl(String action) {
            runOnUiThread(() -> {
                if (!ytEnabled) return;
                ensureYtWebView();
                runYtAction(action);
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
            boolean terrain = host.equals("s3.amazonaws.com")
                && url.getPath().matches("/elevation-tiles-prod/terrarium/10/[0-9]{1,4}/[0-9]{1,4}\\.png")
                && url.getQuery() == null;
            if (!"https".equals(url.getProtocol()) || (url.getPort() != -1 && url.getPort() != 443)
                || url.getUserInfo() != null || !(studio || terrain || PROVIDERS.contains(host))) throw new IllegalArgumentException();
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
        int end = Math.min(offset + 192000, base64.length());
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
    @Override protected void onResume() { super.onResume(); resumed = true; web.onResume(); updateCompassRegistration(); if (voiceController != null) voiceController.onResume(); }
    @Override protected void onPause() { resumed = false; stopVoice(); if (voiceController != null) voiceController.onPause(); updateCompassRegistration(); web.onPause(); super.onPause(); }
    @Override protected void onDestroy() {
        if (voiceController != null) {
            voiceController.shutdown();
            voiceController = null;
        }
        if (audioManager != null) {
            audioManager.shutdown();
            audioManager = null;
        }
        for (int id : new java.util.ArrayList<>(locations.keySet())) stopLocation(id);
        sensors.unregisterListener(this);
        requests.shutdownNow();
        plannerRequests.shutdownNow();
        locationHandler.removeCallbacks(ytSyncTask);
        if (ytWeb != null) { ytWeb.destroy(); ytWeb = null; }
        if (offlineEngine != null) { offlineEngine.close(); offlineEngine = null; }
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }
}
