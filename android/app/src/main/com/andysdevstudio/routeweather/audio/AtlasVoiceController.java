package com.andysdevstudio.routeweather.audio;

import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.Log;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.Locale;

/**
 * Hands-free "Router" voice command controller, confirmation tone generator,
 * and Android MediaSession bridge (for Gemini & Bluetooth steering-wheel controls).
 *
 * Uses Android 12+ on-device SpeechRecognizer (AiAiSpeechRecognitionService) when
 * available so continuous standby listening is completely SILENT (zero start/stop dings).
 */
public final class AtlasVoiceController {
    private static final String TAG = "AtlasVoiceController";
    private static final long STANDBY_RESTART_MS = 450L;
    private static final long ERROR_BACKOFF_MS = 1800L;

    public interface Callbacks {
        boolean isResumed();
        boolean hasRecordPermission();
        void onStateChanged(String state, boolean handsFree);
        void onTranscripts(String candidatesJson, boolean requireWakeWord);
        void onMediaAction(String action);
        void onDuckForListening(boolean duck);
    }

    private final Context context;
    private final Callbacks callbacks;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Runnable restartTask;

    private SpeechRecognizer recognizer;
    private boolean usingOnDeviceRecognizer;
    private ToneGenerator toneGenerator;
    private MediaSession mediaSession;

    private boolean handsFreeEnabled;
    private boolean directListening;
    private boolean recognizerActive;
    private boolean suspendedForTts;
    private int activeSessionId = 0;
    private int consecutiveErrors = 0;
    private final Runnable watchdogTask;

    public AtlasVoiceController(Context context, Callbacks callbacks) {
        this.context = context.getApplicationContext();
        this.callbacks = callbacks;
        this.restartTask = () -> {
            if (!this.callbacks.isResumed() || suspendedForTts) return;
            if (directListening) {
                beginRecognition(false);
            } else if (handsFreeEnabled) {
                beginRecognition(true);
            }
        };
        this.watchdogTask = new Runnable() {
            @Override public void run() {
                if (!AtlasVoiceController.this.callbacks.isResumed() || !handsFreeEnabled) return;
                if (!recognizerActive && !directListening && !suspendedForTts && AtlasVoiceController.this.callbacks.hasRecordPermission()) {
                    Log.i(TAG, "Watchdog reviving silent Router standby");
                    beginRecognition(true);
                }
                mainHandler.postDelayed(this, 8000L);
            }
        };
        initToneGenerator();
        initMediaSession();
    }

    private void initToneGenerator() {
        try {
            toneGenerator = new ToneGenerator(AudioManager.STREAM_NOTIFICATION, 70);
        } catch (Exception e) {
            Log.w(TAG, "ToneGenerator unavailable", e);
        }
    }

    private void initMediaSession() {
        try {
            mediaSession = new MediaSession(context, "RouteWeatherAtlas");
            mediaSession.setCallback(new MediaSession.Callback() {
                @Override public void onPlay() { callbacks.onMediaAction("media_play"); }
                @Override public void onPause() { callbacks.onMediaAction("media_pause"); }
                @Override public void onStop() { callbacks.onMediaAction("media_pause"); }
                @Override public void onSkipToNext() { callbacks.onMediaAction("media_next"); }
                @Override public void onSkipToPrevious() { callbacks.onMediaAction("media_prev"); }
            });
            updateMediaPlaybackState(false);
            mediaSession.setActive(true);
        } catch (Exception e) {
            Log.w(TAG, "MediaSession unavailable", e);
        }
    }

    public void updateMediaPlaybackState(boolean playing) {
        if (mediaSession == null) return;
        try {
            long actions = PlaybackState.ACTION_PLAY
                | PlaybackState.ACTION_PAUSE
                | PlaybackState.ACTION_PLAY_PAUSE
                | PlaybackState.ACTION_SKIP_TO_NEXT
                | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                | PlaybackState.ACTION_STOP;
            int state = playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED;
            mediaSession.setPlaybackState(new PlaybackState.Builder()
                .setActions(actions)
                .setState(state, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1f)
                .build());
        } catch (Exception ignored) {}
    }

    public void playTone(String kind) {
        if (toneGenerator == null) return;
        mainHandler.post(() -> {
            try {
                if ("listen".equals(kind)) {
                    toneGenerator.startTone(ToneGenerator.TONE_PROP_BEEP, 95);
                } else if ("ok".equals(kind)) {
                    toneGenerator.startTone(ToneGenerator.TONE_PROP_ACK, 115);
                } else if ("error".equals(kind)) {
                    toneGenerator.startTone(ToneGenerator.TONE_PROP_NACK, 160);
                }
            } catch (Exception ignored) {}
        });
    }

    /**
     * Toggle a single direct command capture.
     * If already actively listening for a direct command, tapping again cleanly cancels it
     * without playing overlapping dings.
     */
    public void toggleDirectListen(boolean withTone) {
        mainHandler.post(() -> {
            if (!callbacks.isResumed() || !callbacks.hasRecordPermission()) return;
            if (directListening) {
                cancelDirectListen();
                return;
            }
            startDirectListenOnMain(withTone);
        });
    }

    /** Force-start direct command capture (e.g. after wake word "Router" detected). */
    public void listenOnce(boolean withTone) {
        mainHandler.post(() -> {
            if (!callbacks.isResumed() || !callbacks.hasRecordPermission()) return;
            startDirectListenOnMain(withTone);
        });
    }

    private void cancelDirectListen() {
        mainHandler.removeCallbacks(restartTask);
        activeSessionId++;
        directListening = false;
        stopRecognizer();
        callbacks.onDuckForListening(false);
        callbacks.onStateChanged(handsFreeEnabled ? "standby" : "idle", handsFreeEnabled);
        if (handsFreeEnabled && callbacks.isResumed() && !suspendedForTts) {
            mainHandler.postDelayed(restartTask, STANDBY_RESTART_MS);
        }
    }

    private void startDirectListenOnMain(boolean withTone) {
        mainHandler.removeCallbacks(restartTask);
        activeSessionId++;
        stopRecognizer();
        directListening = true;
        if (withTone) playTone("listen");
        callbacks.onDuckForListening(true);
        callbacks.onStateChanged("listening", handsFreeEnabled);
        final int targetSession = activeSessionId;
        mainHandler.postDelayed(() -> {
            if (activeSessionId == targetSession && directListening && callbacks.isResumed()) {
                beginRecognition(false);
            }
        }, withTone ? 170L : 0L);
    }

    public void setHandsFree(boolean enabled) {
        mainHandler.post(() -> {
            handsFreeEnabled = enabled;
            mainHandler.removeCallbacks(restartTask);
            mainHandler.removeCallbacks(watchdogTask);
            activeSessionId++;
            if (!enabled) {
                directListening = false;
                stopRecognizer();
                callbacks.onDuckForListening(false);
                callbacks.onStateChanged("idle", false);
                return;
            }
            if (!callbacks.isResumed() || !callbacks.hasRecordPermission()) {
                callbacks.onStateChanged("standby", true);
                return;
            }
            if (!suspendedForTts && !directListening) {
                beginRecognition(true);
            }
            mainHandler.postDelayed(watchdogTask, 8000L);
            callbacks.onStateChanged("standby", true);
        });
    }

    public boolean isHandsFreeEnabled() {
        return handsFreeEnabled;
    }

    /** Automatically pauses mic capture while AtlasAudioManager is speaking so TTS never triggers Router. */
    public void setSuspendedForTts(boolean suspended) {
        mainHandler.post(() -> {
            suspendedForTts = suspended;
            if (suspended) {
                mainHandler.removeCallbacks(restartTask);
                activeSessionId++;
                if (recognizerActive) stopRecognizer();
            } else if (callbacks.isResumed() && handsFreeEnabled && !directListening) {
                mainHandler.postDelayed(restartTask, STANDBY_RESTART_MS);
            }
        });
    }

    public void onPause() {
        mainHandler.post(() -> {
            mainHandler.removeCallbacks(restartTask);
            mainHandler.removeCallbacks(watchdogTask);
            activeSessionId++;
            directListening = false;
            stopRecognizer();
            callbacks.onDuckForListening(false);
        });
    }

    public void onResume() {
        mainHandler.post(() -> {
            if (handsFreeEnabled && !suspendedForTts && callbacks.hasRecordPermission()) {
                mainHandler.postDelayed(restartTask, STANDBY_RESTART_MS);
                mainHandler.removeCallbacks(watchdogTask);
                mainHandler.postDelayed(watchdogTask, 8000L);
                callbacks.onStateChanged("standby", true);
            }
        });
    }

    public void shutdown() {
        mainHandler.post(() -> {
            mainHandler.removeCallbacks(restartTask);
            mainHandler.removeCallbacks(watchdogTask);
            activeSessionId++;
            handsFreeEnabled = false;
            directListening = false;
            stopRecognizer();
            if (recognizer != null) {
                try { recognizer.destroy(); } catch (Exception ignored) {}
                recognizer = null;
            }
            if (toneGenerator != null) {
                try { toneGenerator.release(); } catch (Exception ignored) {}
                toneGenerator = null;
            }
            if (mediaSession != null) {
                try {
                    mediaSession.setActive(false);
                    mediaSession.release();
                } catch (Exception ignored) {}
                mediaSession = null;
            }
        });
    }

    private void ensureRecognizer() {
        if (recognizer != null) return;
        // Prefer Android 12+ on-device recognizer (AiAi) — runs offline and produces ZERO system dings!
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) {
            try {
                recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(context);
                usingOnDeviceRecognizer = true;
                Log.i(TAG, "Using silent on-device SpeechRecognizer");
            } catch (Exception e) {
                Log.w(TAG, "On-device SpeechRecognizer failed, falling back", e);
            }
        }
        if (recognizer == null) {
            if (!SpeechRecognizer.isRecognitionAvailable(context)) {
                Log.w(TAG, "SpeechRecognizer unavailable on this device");
                return;
            }
            recognizer = SpeechRecognizer.createSpeechRecognizer(context);
            usingOnDeviceRecognizer = false;
            Log.i(TAG, "Using standard SpeechRecognizer");
        }
        recognizer.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle params) {
                recognizerActive = true;
                callbacks.onStateChanged(directListening ? "listening" : "standby", handsFreeEnabled);
            }
            @Override public void onBeginningOfSpeech() {}
            @Override public void onRmsChanged(float rmsdB) {}
            @Override public void onBufferReceived(byte[] buffer) {}
            @Override public void onEndOfSpeech() {
                recognizerActive = false;
            }
            @Override public void onError(int error) {
                recognizerActive = false;
                boolean wasDirect = directListening;
                directListening = false;
                if (wasDirect) {
                    callbacks.onDuckForListening(false);
                    if (error != SpeechRecognizer.ERROR_CLIENT
                        && error != SpeechRecognizer.ERROR_NO_MATCH
                        && error != SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                        playTone("error");
                    }
                }
                if (error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY || error == SpeechRecognizer.ERROR_SERVER_DISCONNECTED) {
                    consecutiveErrors++;
                    if (consecutiveErrors >= 2 && recognizer != null) {
                        try { recognizer.destroy(); } catch (Exception ignored) {}
                        recognizer = null;
                        consecutiveErrors = 0;
                    }
                } else {
                    consecutiveErrors = 0;
                }
                callbacks.onStateChanged(handsFreeEnabled ? "standby" : "idle", handsFreeEnabled);
                if (handsFreeEnabled && callbacks.isResumed() && !suspendedForTts) {
                    long delay = (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT)
                        ? STANDBY_RESTART_MS : ERROR_BACKOFF_MS;
                    mainHandler.removeCallbacks(restartTask);
                    mainHandler.postDelayed(restartTask, delay);
                }
            }
            @Override public void onResults(Bundle results) {
                recognizerActive = false;
                boolean requireWake = !directListening;
                directListening = false;
                callbacks.onDuckForListening(false);
                ArrayList<String> matches = results != null
                    ? results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION) : null;
                if (matches != null && !matches.isEmpty()) {
                    JSONArray arr = new JSONArray();
                    for (String m : matches) {
                        if (m != null && !m.trim().isEmpty()) arr.put(m.trim());
                    }
                    if (arr.length() > 0) {
                        Log.i(TAG, "Recognized (wakeReq=" + requireWake + "): " + arr.toString());
                        callbacks.onTranscripts(arr.toString(), requireWake);
                    }
                }
                callbacks.onStateChanged(handsFreeEnabled ? "standby" : "idle", handsFreeEnabled);
                if (handsFreeEnabled && callbacks.isResumed() && !suspendedForTts && !directListening) {
                    mainHandler.postDelayed(restartTask, STANDBY_RESTART_MS);
                }
            }
            @Override public void onPartialResults(Bundle partialResults) {}
            @Override public void onEvent(int eventType, Bundle params) {}
        });
    }

    private void beginRecognition(boolean wakeMode) {
        if (!callbacks.isResumed() || !callbacks.hasRecordPermission()) return;
        ensureRecognizer();
        if (recognizer == null) {
            directListening = false;
            callbacks.onDuckForListening(false);
            callbacks.onStateChanged("unavailable", false);
            return;
        }
        if (recognizerActive) {
            try { recognizer.cancel(); } catch (Exception ignored) {}
            recognizerActive = false;
        }
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.US.toLanguageTag());
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5);
        if (!usingOnDeviceRecognizer) {
            intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
        }
        if (wakeMode) {
            // Longer silence window in standby so it doesn't churn restarts every few seconds
            intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 15000L);
            intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2200L);
            intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1800L);
        }
        try {
            recognizerActive = true;
            recognizer.startListening(intent);
        } catch (Exception e) {
            recognizerActive = false;
            Log.w(TAG, "startListening failed", e);
        }
    }

    private void stopRecognizer() {
        if (recognizer != null && recognizerActive) {
            try { recognizer.cancel(); } catch (Exception ignored) {}
        }
        recognizerActive = false;
    }
}
