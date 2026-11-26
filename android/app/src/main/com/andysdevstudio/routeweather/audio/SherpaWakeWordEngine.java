package com.andysdevstudio.routeweather.audio;

import android.annotation.SuppressLint;
import android.content.Context;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import android.media.audiofx.NoiseSuppressor;
import android.os.SystemClock;
import android.util.Log;

import com.k2fsa.sherpa.onnx.FeatureConfig;
import com.k2fsa.sherpa.onnx.KeywordSpotter;
import com.k2fsa.sherpa.onnx.KeywordSpotterConfig;
import com.k2fsa.sherpa.onnx.KeywordSpotterResult;
import com.k2fsa.sherpa.onnx.OnlineModelConfig;
import com.k2fsa.sherpa.onnx.OnlineStream;
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 100% offline, completely silent local wake-word detector powered by Sherpa-ONNX KWS.
 * Reads raw 16 kHz mono PCM via AudioRecord (never touches Android's SpeechRecognizer
 * during standby), eliminating system start/stop beeps completely.
 */
public final class SherpaWakeWordEngine {
    private static final String TAG = "SherpaWakeWord";
    private static final int SAMPLE_RATE = 16000;
    private static final int CHUNK_SAMPLES = 1600; // 100 ms at 16 kHz
    private static final long COOLDOWN_MS = 1800L;

    public interface Listener {
        void onWakeWordDetected(String keyword);
        void onEngineReady(boolean ready);
    }

    private final Context context;
    private final Listener listener;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private final AtomicBoolean released = new AtomicBoolean(false);

    private volatile KeywordSpotter spotter;
    private Thread workerThread;
    private long lastTriggerAt = 0L;

    public SherpaWakeWordEngine(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
        new Thread(this::initSpotter, "SherpaKwsInit").start();
    }

    private void initSpotter() {
        if (released.get()) return;
        try {
            OnlineTransducerModelConfig transducer = new OnlineTransducerModelConfig();
            transducer.setEncoder("kws/encoder.int8.onnx");
            transducer.setDecoder("kws/decoder.onnx");
            transducer.setJoiner("kws/joiner.int8.onnx");

            OnlineModelConfig modelConfig = new OnlineModelConfig();
            modelConfig.setTransducer(transducer);
            modelConfig.setTokens("kws/tokens.txt");
            modelConfig.setNumThreads(2);
            modelConfig.setProvider("cpu");
            modelConfig.setDebug(false);

            FeatureConfig featConfig = new FeatureConfig(SAMPLE_RATE, 80, 0.0f);

            KeywordSpotterConfig config = new KeywordSpotterConfig();
            config.setFeatConfig(featConfig);
            config.setModelConfig(modelConfig);
            config.setMaxActivePaths(4);
            config.setKeywordsFile("kws/keywords.txt");
            config.setKeywordsScore(1.5f);
            config.setKeywordsThreshold(0.25f);
            config.setNumTrailingBlanks(1);

            KeywordSpotter ks = new KeywordSpotter(context.getAssets(), config);
            if (released.get()) {
                ks.release();
                return;
            }
            this.spotter = ks;
            Log.i(TAG, "Sherpa-ONNX silent wake-word engine ready (ROUTER / ROUTE_ATLAS)");
            listener.onEngineReady(true);
        } catch (Throwable t) {
            Log.e(TAG, "Failed to initialize Sherpa-ONNX wake-word engine", t);
            listener.onEngineReady(false);
        }
    }

    public boolean isReady() {
        return spotter != null && !released.get();
    }

    public synchronized void start() {
        if (released.get() || running.get()) return;
        if (spotter == null) return;
        running.set(true);
        workerThread = new Thread(this::captureLoop, "SherpaKwsLoop");
        workerThread.setPriority(Thread.NORM_PRIORITY);
        workerThread.start();
    }

    public synchronized void stop() {
        running.set(false);
        Thread t = workerThread;
        workerThread = null;
        if (t != null && t != Thread.currentThread()) {
            try { t.join(500L); } catch (InterruptedException ignored) {}
        }
    }

    public void release() {
        released.set(true);
        stop();
        KeywordSpotter ks = spotter;
        spotter = null;
        if (ks != null) {
            try { ks.release(); } catch (Exception ignored) {}
        }
    }

    @SuppressLint("MissingPermission")
    private void captureLoop() {
        AudioRecord recorder = null;
        AcousticEchoCanceler aec = null;
        NoiseSuppressor ns = null;
        OnlineStream stream = null;
        try {
            int minBuf = AudioRecord.getMinBufferSize(
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            );
            int bufSize = Math.max(minBuf * 2, CHUNK_SAMPLES * 4);
            recorder = new AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufSize
            );
            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
                Log.w(TAG, "AudioRecord failed to initialize");
                return;
            }
            int sessionId = recorder.getAudioSessionId();
            if (AcousticEchoCanceler.isAvailable()) {
                try {
                    aec = AcousticEchoCanceler.create(sessionId);
                    if (aec != null) aec.setEnabled(true);
                } catch (Exception ignored) {}
            }
            if (NoiseSuppressor.isAvailable()) {
                try {
                    ns = NoiseSuppressor.create(sessionId);
                    if (ns != null) ns.setEnabled(true);
                } catch (Exception ignored) {}
            }

            KeywordSpotter ks = this.spotter;
            if (ks == null) return;
            stream = ks.createStream("");
            recorder.startRecording();
            Log.i(TAG, "Silent AudioRecord wake-word listening started");

            short[] pcm = new short[CHUNK_SAMPLES];
            float[] floats = new float[CHUNK_SAMPLES];

            while (running.get() && !released.get()) {
                int read = recorder.read(pcm, 0, pcm.length);
                if (read <= 0) {
                    if (read < 0) break;
                    continue;
                }
                for (int i = 0; i < read; i++) {
                    floats[i] = pcm[i] / 32768.0f;
                }
                float[] chunk = (read == floats.length) ? floats : java.util.Arrays.copyOf(floats, read);
                stream.acceptWaveform(chunk, SAMPLE_RATE);
                while (ks.isReady(stream)) {
                    ks.decode(stream);
                }
                KeywordSpotterResult result = ks.getResult(stream);
                String kw = result != null ? result.getKeyword() : null;
                if (kw != null && !kw.trim().isEmpty()) {
                    ks.reset(stream);
                    long now = SystemClock.elapsedRealtime();
                    if (now - lastTriggerAt >= COOLDOWN_MS) {
                        lastTriggerAt = now;
                        Log.i(TAG, "Wake word detected silently: " + kw);
                        // Stop capturing right away so Android SpeechRecognizer can take the mic cleanly
                        running.set(false);
                        listener.onWakeWordDetected(kw.trim());
                        break;
                    }
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "Wake-word capture loop ended", t);
        } finally {
            if (stream != null) {
                try { stream.release(); } catch (Exception ignored) {}
            }
            if (aec != null) {
                try { aec.release(); } catch (Exception ignored) {}
            }
            if (ns != null) {
                try { ns.release(); } catch (Exception ignored) {}
            }
            if (recorder != null) {
                try {
                    if (recorder.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) {
                        recorder.stop();
                    }
                } catch (Exception ignored) {}
                try { recorder.release(); } catch (Exception ignored) {}
            }
            Log.i(TAG, "Silent AudioRecord wake-word listening stopped");
        }
    }
}
