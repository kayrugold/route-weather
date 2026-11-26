package com.andysdevstudio.routeweather.audio;

import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.Log;

import java.util.ArrayList;
import java.util.Locale;

/**
 * Hands-free "Router" voice command controller, confirmation tone generator,
 * and Android MediaSession bridge (for Gemini & Bluetooth steering-wheel controls).
 */
public final class AtlasVoiceController {
    private static final String TAG = "AtlasVoiceController";
    private static final long RESTART_DELAY_MS = 650L;
    private static final long ERROR_BACKOFF_MS = 1800L;

    public interface Callbacks {
        boolean isResumed();
        boolean hasRecordPermission();
        void onStateChanged(String state, boolean handsFree);
        void onTranscript(String transcript, boolean requireWakeWord);
        void onMediaAction(String action);
        void onDuckForListening(boolean duck);
    }

    private final Context context;
    private final Callbacks callbacks;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private SpeechRecognizer recognizer;
    private ToneGenerator toneGenerator;
    private MediaSession mediaSession;

    private boolean handsFreeEnabled;
    private boolean directListening;
    private boolean recognizerActive;
    private boolean suspendedForTts;

    private final Runnable restartTask;

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
        initToneGenerator();
        initMediaSession();
    }

    private void initToneGenerator() {
        try {
            toneGenerator = new ToneGenerator(AudioManager.STREAM_NOTIFICATION, 75);
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
                    toneGenerator.startTone(ToneGenerator.TONE_PROP_BEEP, 110);
                } else if ("ok".equals(kind)) {
                    toneGenerator.startTone(ToneGenerator.TONE_PROP_ACK, 130);
                } else if ("error".equals(kind)) {
                    toneGenerator.startTone(ToneGenerator.TONE_PROP_NACK, 180);
                }
            } catch (Exception ignored) {}
        });
    }

    /** Trigger a single direct command capture (e.g., mic tap or after wake-word "Router"). */
    public void listenOnce(boolean withTone) {
        mainHandler.post(() -> {
            if (!callbacks.isResumed() || !callbacks.hasRecordPermission()) return;
            mainHandler.removeCallbacks(restartTask);
            directListening = true;
            if (withTone) playTone("listen");
            callbacks.onDuckForListening(true);
            callbacks.onStateChanged("listening", handsFreeEnabled);
            // Slight delay so the listen ding doesn't bleed into speech capture
            mainHandler.postDelayed(() -> beginRecognition(false), withTone ? 160L : 0L);
        });
    }

    public void setHandsFree(boolean enabled) {
        mainHandler.post(() -> {
            handsFreeEnabled = enabled;
            mainHandler.removeCallbacks(restartTask);
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
                if (recognizerActive) stopRecognizer();
            } else if (callbacks.isResumed() && handsFreeEnabled && !directListening) {
                mainHandler.postDelayed(restartTask, RESTART_DELAY_MS);
            }
        });
    }

    public void onPause() {
        mainHandler.post(() -> {
            mainHandler.removeCallbacks(restartTask);
            directListening = false;
            stopRecognizer();
            callbacks.onDuckForListening(false);
        });
    }

    public void onResume() {
        mainHandler.post(() -> {
            if (handsFreeEnabled && !suspendedForTts && callbacks.hasRecordPermission()) {
                mainHandler.postDelayed(restartTask, RESTART_DELAY_MS);
                callbacks.onStateChanged("standby", true);
            }
        });
    }

    public void shutdown() {
        mainHandler.post(() -> {
            mainHandler.removeCallbacks(restartTask);
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
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            Log.w(TAG, "SpeechRecognizer unavailable on this device");
            return;
        }
        recognizer = SpeechRecognizer.createSpeechRecognizer(context);
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
                    if (error != SpeechRecognizer.ERROR_CLIENT && error != SpeechRecognizer.ERROR_NO_MATCH) {
                        playTone("error");
                    }
                }
                callbacks.onStateChanged(handsFreeEnabled ? "standby" : "idle", handsFreeEnabled);
                if (handsFreeEnabled && callbacks.isResumed() && !suspendedForTts) {
                    long delay = (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT)
                        ? RESTART_DELAY_MS : ERROR_BACKOFF_MS;
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
                String best = (matches != null && !matches.isEmpty()) ? matches.get(0) : "";
                if (!best.trim().isEmpty()) {
                    callbacks.onTranscript(best.trim(), requireWake);
                }
                callbacks.onStateChanged(handsFreeEnabled ? "standby" : "idle", handsFreeEnabled);
                if (handsFreeEnabled && callbacks.isResumed() && !suspendedForTts && !directListening) {
                    mainHandler.postDelayed(restartTask, RESTART_DELAY_MS);
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
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
        if (wakeMode) {
            intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1200L);
            intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1000L);
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
