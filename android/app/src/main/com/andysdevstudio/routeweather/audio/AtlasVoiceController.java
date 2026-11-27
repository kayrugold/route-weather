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
 * Hands-free "Router" voice command controller:
 *  - Standby: 100% SILENT local Sherpa-ONNX keyword spotter over raw AudioRecord (ZERO beeps!).
 *  - Command capture: On-demand one-shot Android SpeechRecognizer (triggered by "Router" or mic tap).
 *  - MediaSession bridge for Gemini / Bluetooth steering-wheel controls.
 */
public final class AtlasVoiceController {
    private static final String TAG = "AtlasVoiceController";
    private static final long RESUME_WAKE_DELAY_MS = 350L;

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
    private final SherpaWakeWordEngine wakeEngine;

    private SpeechRecognizer recognizer;
    private boolean usingOnDeviceRecognizer;
    private ToneGenerator toneGenerator;
    private MediaSession mediaSession;

    private boolean handsFreeEnabled;
    private boolean directListening;
    private boolean recognizerActive;
    private boolean suspendedForTts;
    private boolean suspendedForRadioTx;
    private int activeSessionId = 0;

    private final Runnable resumeWakeTask = new Runnable() {
        @Override public void run() {
            if (!callbacks.isResumed() || !handsFreeEnabled || directListening || suspendedForTts || suspendedForRadioTx) return;
            if (!callbacks.hasRecordPermission()) return;
            if (wakeEngine.isReady()) {
                wakeEngine.start();
                callbacks.onStateChanged("standby", true);
            }
        }
    };

    public AtlasVoiceController(Context context, Callbacks callbacks) {
        this.context = context.getApplicationContext();
        this.callbacks = callbacks;
        initToneGenerator();
        initMediaSession();
        this.wakeEngine = new SherpaWakeWordEngine(this.context, new SherpaWakeWordEngine.Listener() {
            @Override public void onWakeWordDetected(String keyword) {
                mainHandler.post(() -> {
                    if (!AtlasVoiceController.this.callbacks.isResumed() || !handsFreeEnabled || directListening || suspendedForTts) {
                        return;
                    }
                    Log.i(TAG, "Wake word '" + keyword + "' -> starting one-shot command capture");
                    startDirectListenOnMain(true);
                });
            }
            @Override public void onEngineReady(boolean ready) {
                if (ready) {
                    mainHandler.post(() -> {
                        if (handsFreeEnabled && AtlasVoiceController.this.callbacks.isResumed()
                            && !directListening && !suspendedForTts && AtlasVoiceController.this.callbacks.hasRecordPermission()) {
                            wakeEngine.start();
                            AtlasVoiceController.this.callbacks.onStateChanged("standby", true);
                        }
                    });
                }
            }
        });
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

    /** Tap mic button: starts one-shot command capture, or cleanly cancels if already listening. */
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

    public void listenOnce(boolean withTone) {
        mainHandler.post(() -> {
            if (!callbacks.isResumed() || !callbacks.hasRecordPermission()) return;
            startDirectListenOnMain(withTone);
        });
    }

    private void cancelDirectListen() {
        mainHandler.removeCallbacks(resumeWakeTask);
        activeSessionId++;
        directListening = false;
        stopRecognizer();
        callbacks.onDuckForListening(false);
        callbacks.onStateChanged(handsFreeEnabled ? "standby" : "idle", handsFreeEnabled);
        scheduleWakeResume();
    }

    private void startDirectListenOnMain(boolean withTone) {
        mainHandler.removeCallbacks(resumeWakeTask);
        activeSessionId++;
        // Release AudioRecord first so Android SpeechRecognizer gets clean mic access
        wakeEngine.stop();
        stopRecognizer();
        directListening = true;
        if (withTone) playTone("listen");
        callbacks.onDuckForListening(true);
        callbacks.onStateChanged("listening", handsFreeEnabled);
        final int targetSession = activeSessionId;
        mainHandler.postDelayed(() -> {
            if (activeSessionId == targetSession && directListening && callbacks.isResumed()) {
                beginOneShotRecognition();
            }
        }, withTone ? 160L : 40L);
    }

    public void setHandsFree(boolean enabled) {
        mainHandler.post(() -> {
            handsFreeEnabled = enabled;
            mainHandler.removeCallbacks(resumeWakeTask);
            if (!enabled) {
                wakeEngine.stop();
                if (!directListening) {
                    callbacks.onStateChanged("idle", false);
                }
                return;
            }
            if (!callbacks.isResumed() || !callbacks.hasRecordPermission()) {
                callbacks.onStateChanged("standby", true);
                return;
            }
            if (!directListening && !suspendedForTts) {
                scheduleWakeResume();
            }
            callbacks.onStateChanged("standby", true);
        });
    }

    public boolean isHandsFreeEnabled() {
        return handsFreeEnabled;
    }

    /** Automatically pauses wake-word listening while AtlasAudioManager is speaking. */
    public void setSuspendedForTts(boolean suspended) {
        mainHandler.post(() -> {
            suspendedForTts = suspended;
            if (suspended) {
                mainHandler.removeCallbacks(resumeWakeTask);
                wakeEngine.stop();
            } else {
                scheduleWakeResume();
            }
        });
    }

    /** Automatically pauses wake-word listening while CB Radio is actively transmitting on the mic. */
    public void setSuspendedForRadioTx(boolean suspended) {
        mainHandler.post(() -> {
            suspendedForRadioTx = suspended;
            if (suspended) {
                mainHandler.removeCallbacks(resumeWakeTask);
                wakeEngine.stop();
                stopRecognizer();
            } else {
                scheduleWakeResume();
            }
        });
    }

    public void onPause() {
        mainHandler.post(() -> {
            mainHandler.removeCallbacks(resumeWakeTask);
            activeSessionId++;
            directListening = false;
            wakeEngine.stop();
            stopRecognizer();
            callbacks.onDuckForListening(false);
        });
    }

    public void onResume() {
        mainHandler.post(() -> {
            if (handsFreeEnabled && !suspendedForTts && callbacks.hasRecordPermission()) {
                scheduleWakeResume();
                callbacks.onStateChanged("standby", true);
            }
        });
    }

    public void shutdown() {
        mainHandler.post(() -> {
            mainHandler.removeCallbacks(resumeWakeTask);
            activeSessionId++;
            handsFreeEnabled = false;
            directListening = false;
            wakeEngine.release();
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

    private void scheduleWakeResume() {
        mainHandler.removeCallbacks(resumeWakeTask);
        if (handsFreeEnabled && !directListening && !suspendedForTts && !suspendedForRadioTx && callbacks.isResumed()) {
            mainHandler.postDelayed(resumeWakeTask, RESUME_WAKE_DELAY_MS);
        }
    }

    private void ensureRecognizer() {
        if (recognizer != null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) {
            try {
                recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(context);
                usingOnDeviceRecognizer = true;
                Log.i(TAG, "One-shot command recognizer: on-device AiAi");
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
        }
        recognizer.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle params) {
                recognizerActive = true;
                callbacks.onStateChanged("listening", handsFreeEnabled);
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
                callbacks.onDuckForListening(false);
                if (wasDirect && error != SpeechRecognizer.ERROR_CLIENT
                    && error != SpeechRecognizer.ERROR_NO_MATCH
                    && error != SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                    playTone("error");
                }
                callbacks.onStateChanged(handsFreeEnabled ? "standby" : "idle", handsFreeEnabled);
                scheduleWakeResume();
            }
            @Override public void onResults(Bundle results) {
                recognizerActive = false;
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
                        Log.i(TAG, "Command recognized: " + arr.toString());
                        callbacks.onTranscripts(arr.toString(), false);
                    }
                }
                callbacks.onStateChanged(handsFreeEnabled ? "standby" : "idle", handsFreeEnabled);
                scheduleWakeResume();
            }
            @Override public void onPartialResults(Bundle partialResults) {}
            @Override public void onEvent(int eventType, Bundle params) {}
        });
    }

    private void beginOneShotRecognition() {
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
        try {
            recognizerActive = true;
            recognizer.startListening(intent);
        } catch (Exception e) {
            recognizerActive = false;
            directListening = false;
            callbacks.onDuckForListening(false);
            Log.w(TAG, "startListening failed", e);
            scheduleWakeResume();
        }
    }

    private void stopRecognizer() {
        if (recognizer != null && recognizerActive) {
            try { recognizer.cancel(); } catch (Exception ignored) {}
        }
        recognizerActive = false;
    }
}
