package com.andysdevstudio.routeweather.audio;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Log;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Centralized audio & TTS coordinator for Route Weather / Atlas.
 * Enforces priority ordering, maneuver deduplication, stale-turn replacement,
 * Android audio focus, and coordinated duck/pause of in-app media (YouTube).
 */
public final class AtlasAudioManager {
    private static final String TAG = "AtlasAudioManager";

    public static final int PRIORITY_EMERGENCY = 1;
    public static final int PRIORITY_NAVIGATION = 2;
    public static final int PRIORITY_VOICE_CMD = 3;
    public static final int PRIORITY_PRIORITY_RADIO = 4;
    public static final int PRIORITY_PUBLIC_RADIO = 5;

    private static final long DEFAULT_DEDUPE_MS = 12_000L;
    private static final long EMERGENCY_DEDUPE_MS = 45_000L;

    public interface Callbacks {
        boolean isResumed();
        void onSpeechEvent(String event, int priority, String key);
        void onDuckMedia(boolean duck);
        void onPauseMedia();
    }

    private static final class SpeechItem {
        final String text;
        final int priority;
        final String dedupeKey;
        final boolean interrupt;
        final boolean pauseMedia;
        final long queuedAt;

        SpeechItem(String text, int priority, String dedupeKey, boolean interrupt, boolean pauseMedia) {
            this.text = text;
            this.priority = priority;
            this.dedupeKey = dedupeKey == null ? "" : dedupeKey;
            this.interrupt = interrupt;
            this.pauseMedia = pauseMedia;
            this.queuedAt = SystemClock.elapsedRealtime();
        }
    }

    private final Context context;
    private final Callbacks callbacks;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final LinkedList<SpeechItem> queue = new LinkedList<>();
    private final List<String> fallbackEngines = new ArrayList<>();

    private TextToSpeech tts;
    private boolean ready;
    private boolean initializing;
    private SpeechItem activeItem;
    private String activeUtteranceId;
    private long utteranceSeq;
    private AudioFocusRequest focusRequest;
    private boolean mediaDucked;

    private String lastSpokenKey = "";
    private long lastSpokenAt = 0L;

    public AtlasAudioManager(Context context, Callbacks callbacks) {
        this.context = context.getApplicationContext();
        this.callbacks = callbacks;
    }

    public void speak(String rawText, int priority, String dedupeKey, boolean interrupt, boolean pauseMedia) {
        mainHandler.post(() -> enqueueOnMain(rawText, priority, dedupeKey, interrupt, pauseMedia));
    }

    public void stopAll() {
        mainHandler.post(() -> stopOnMain(PRIORITY_PUBLIC_RADIO));
    }

    /** Stops active/queued items whose priority is >= minPriority (e.g., 2 stops nav & lower, preserves emergency). */
    public void stopFromPriority(int minPriority) {
        mainHandler.post(() -> stopOnMain(minPriority));
    }

    public void shutdown() {
        mainHandler.post(() -> {
            stopOnMain(PRIORITY_EMERGENCY);
            if (tts != null) {
                try { tts.shutdown(); } catch (Exception ignored) {}
                tts = null;
            }
            ready = false;
            initializing = false;
        });
    }

    private void enqueueOnMain(String rawText, int priority, String dedupeKey, boolean interrupt, boolean pauseMedia) {
        if (!callbacks.isResumed()) return;
        if (rawText == null) return;
        String text = rawText.trim();
        if (text.isEmpty() || text.length() > 600) return;

        int clampedPriority = Math.max(PRIORITY_EMERGENCY, Math.min(PRIORITY_PUBLIC_RADIO, priority));
        String key = (dedupeKey == null || dedupeKey.trim().isEmpty())
            ? (clampedPriority + ":" + text.toLowerCase(Locale.US))
            : dedupeKey.trim();

        long now = SystemClock.elapsedRealtime();
        long dedupeWindow = clampedPriority == PRIORITY_EMERGENCY ? EMERGENCY_DEDUPE_MS : DEFAULT_DEDUPE_MS;
        if (key.equals(lastSpokenKey) && (now - lastSpokenAt) < dedupeWindow) {
            return;
        }
        if (activeItem != null && key.equals(activeItem.dedupeKey)) {
            return;
        }

        // Remove any duplicate or obsolete queued items of the same key,
        // and for navigation replace any older queued navigation prompt so turns never pile up.
        Iterator<SpeechItem> it = queue.iterator();
        while (it.hasNext()) {
            SpeechItem existing = it.next();
            if (existing.dedupeKey.equals(key)) {
                it.remove();
            } else if (clampedPriority == PRIORITY_NAVIGATION && existing.priority == PRIORITY_NAVIGATION) {
                it.remove();
            }
        }

        SpeechItem item = new SpeechItem(text, clampedPriority, key, interrupt, pauseMedia);

        // Insert in priority order (lower priority number = higher urgency)
        int insertAt = queue.size();
        for (int i = 0; i < queue.size(); i++) {
            if (clampedPriority < queue.get(i).priority) {
                insertAt = i;
                break;
            }
        }
        queue.add(insertAt, item);

        if (!ready) {
            if (!initializing) startEngine(null);
            return;
        }

        boolean shouldPreempt = activeItem != null && (
            clampedPriority < activeItem.priority
                || (interrupt && clampedPriority <= activeItem.priority)
        );
        if (shouldPreempt) {
            activeItem = null;
            activeUtteranceId = null;
            try { tts.stop(); } catch (Exception ignored) {}
            pumpQueue();
        } else if (activeItem == null) {
            pumpQueue();
        }
    }

    private void stopOnMain(int minPriority) {
        Iterator<SpeechItem> it = queue.iterator();
        while (it.hasNext()) {
            if (it.next().priority >= minPriority) it.remove();
        }
        if (activeItem != null && activeItem.priority >= minPriority) {
            activeItem = null;
            activeUtteranceId = null;
            if (ready && tts != null) {
                try { tts.stop(); } catch (Exception ignored) {}
            }
            if (queue.isEmpty()) {
                releaseFocusAndRestoreMedia();
            } else {
                pumpQueue();
            }
        } else if (activeItem == null && queue.isEmpty()) {
            releaseFocusAndRestoreMedia();
        }
    }

    private void pumpQueue() {
        if (!ready || tts == null || !callbacks.isResumed()) {
            releaseFocusAndRestoreMedia();
            return;
        }
        if (activeItem != null) return;

        // Drop stale navigation items older than 12s
        long now = SystemClock.elapsedRealtime();
        while (!queue.isEmpty()) {
            SpeechItem head = queue.peekFirst();
            if (head.priority == PRIORITY_NAVIGATION && (now - head.queuedAt) > 12_000L) {
                queue.removeFirst();
                continue;
            }
            break;
        }

        if (queue.isEmpty()) {
            releaseFocusAndRestoreMedia();
            return;
        }

        SpeechItem next = queue.removeFirst();
        AudioAttributes attributes = new AudioAttributes.Builder()
            .setUsage(next.priority == PRIORITY_EMERGENCY
                ? AudioAttributes.USAGE_ALARM
                : AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build();
        tts.setAudioAttributes(attributes);

        if (!ensureFocus(attributes, next.pauseMedia)) {
            Log.w(TAG, "Audio focus unavailable for priority " + next.priority);
            if (queue.isEmpty()) releaseFocusAndRestoreMedia();
            return;
        }

        if (next.pauseMedia) {
            callbacks.onPauseMedia();
        } else if (!mediaDucked) {
            mediaDucked = true;
            callbacks.onDuckMedia(true);
        }

        activeItem = next;
        activeUtteranceId = "atlas-utt-" + (++utteranceSeq);
        lastSpokenKey = next.dedupeKey;
        lastSpokenAt = SystemClock.elapsedRealtime();

        int res = tts.speak(next.text, TextToSpeech.QUEUE_FLUSH, null, activeUtteranceId);
        if (res != TextToSpeech.SUCCESS) {
            SpeechItem failed = activeItem;
            activeItem = null;
            activeUtteranceId = null;
            callbacks.onSpeechEvent("error", failed.priority, failed.dedupeKey);
            pumpQueue();
        }
    }

    private boolean ensureFocus(AudioAttributes attributes, boolean exclusivePause) {
        AudioManager am = context.getSystemService(AudioManager.class);
        if (am == null) return true;
        if (focusRequest != null) return true;
        int gainType = exclusivePause
            ? AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
            : AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK;
        focusRequest = new AudioFocusRequest.Builder(gainType)
            .setAudioAttributes(attributes)
            .setOnAudioFocusChangeListener(change -> {
                if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
                    stopFromPriority(PRIORITY_NAVIGATION);
                }
            })
            .build();
        int granted = am.requestAudioFocus(focusRequest);
        if (granted != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            focusRequest = null;
            return false;
        }
        return true;
    }

    private void releaseFocusAndRestoreMedia() {
        if (mediaDucked) {
            mediaDucked = false;
            callbacks.onDuckMedia(false);
        }
        if (focusRequest != null) {
            AudioFocusRequest prev = focusRequest;
            focusRequest = null;
            AudioManager am = context.getSystemService(AudioManager.class);
            if (am != null) {
                try { am.abandonAudioFocusRequest(prev); } catch (Exception ignored) {}
            }
        }
    }

    private void finishUtterance(String id, String event) {
        mainHandler.post(() -> {
            if (activeUtteranceId == null || !activeUtteranceId.equals(id)) return;
            SpeechItem finished = activeItem;
            activeItem = null;
            activeUtteranceId = null;
            if (finished != null) {
                callbacks.onSpeechEvent(event, finished.priority, finished.dedupeKey);
            }
            if (queue.isEmpty()) {
                releaseFocusAndRestoreMedia();
            } else {
                pumpQueue();
            }
        });
    }

    private void engineUnavailable(String detail) {
        Log.w(TAG, detail);
        if (tts != null) {
            try { tts.shutdown(); } catch (Exception ignored) {}
            tts = null;
        }
        ready = false;
        if (!fallbackEngines.isEmpty() && !queue.isEmpty()) {
            startEngine(fallbackEngines.remove(0));
        } else {
            initializing = false;
            queue.clear();
            releaseFocusAndRestoreMedia();
            callbacks.onSpeechEvent("error", PRIORITY_NAVIGATION, "");
        }
    }

    private void startEngine(String engineName) {
        initializing = true;
        TextToSpeech.OnInitListener listener = result -> mainHandler.post(() -> {
            if (tts == null) {
                initializing = false;
                return;
            }
            if (engineName == null) {
                fallbackEngines.clear();
                String def = tts.getDefaultEngine();
                for (TextToSpeech.EngineInfo info : tts.getEngines()) {
                    if (!info.name.equals(def)) fallbackEngines.add(info.name);
                }
            }
            if (result != TextToSpeech.SUCCESS) {
                engineUnavailable("Could not initialize speech engine");
                return;
            }
            tts.setLanguage(Locale.US);
            Voice localEnglish = null;
            Set<Voice> voices = tts.getVoices();
            if (voices != null) {
                for (Voice v : voices) {
                    if (!v.isNetworkConnectionRequired()
                        && "en".equals(v.getLocale().getLanguage())
                        && (v.getFeatures() == null || !v.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED))
                        && (localEnglish == null || Locale.US.equals(v.getLocale()))) {
                        localEnglish = v;
                    }
                }
            }
            if (localEnglish == null || tts.setVoice(localEnglish) != TextToSpeech.SUCCESS) {
                engineUnavailable("No usable offline English voice in this engine");
                return;
            }
            ready = true;
            initializing = false;
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) {
                    mainHandler.post(() -> {
                        if (activeUtteranceId != null && activeUtteranceId.equals(id) && activeItem != null) {
                            callbacks.onSpeechEvent("start", activeItem.priority, activeItem.dedupeKey);
                        }
                    });
                }
                @Override public void onDone(String id) { finishUtterance(id, "done"); }
                @Override public void onError(String id) {
                    Log.w(TAG, "Speech engine could not play utterance");
                    finishUtterance(id, "error");
                }
            });
            pumpQueue();
        });
        tts = engineName == null ? new TextToSpeech(context, listener) : new TextToSpeech(context, listener, engineName);
    }
}
