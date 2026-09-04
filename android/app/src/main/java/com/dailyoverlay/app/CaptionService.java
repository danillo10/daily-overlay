package com.dailyoverlay.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.IBinder;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class CaptionService extends Service {
    public static final String ACTION_START = "com.dailyoverlay.app.START";
    public static final String ACTION_STOP = "com.dailyoverlay.app.STOP";
    private static final String CHANNEL = "daily-overlay";
    private static final int SAMPLE_RATE = 16000;
    private static final int CHUNK_MS = 1800;

    private volatile boolean running;
    private Thread captureThread;
    private final ExecutorService jobs = Executors.newSingleThreadExecutor();

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopWork();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        startForeground(1, notification());
        startWork();
        return START_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        stopWork();
        jobs.shutdownNow();
        super.onDestroy();
    }

    private void startWork() {
        if (running) return;
        running = true;
        CaptionBus.get().setRunning(true);
        CaptionBus.get().status("Escutando o microfone");
        captureThread = new Thread(this::captureLoop, "daily-capture");
        captureThread.start();
    }

    private void stopWork() {
        running = false;
        if (captureThread != null) {
            captureThread.interrupt();
            captureThread = null;
        }
        CaptionBus.get().setRunning(false);
        CaptionBus.get().status("Pronto");
    }

    private void captureLoop() {
        int min = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        int chunkBytes = SAMPLE_RATE * 2 * CHUNK_MS / 1000;
        AudioRecord recorder = new AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                Math.max(min, chunkBytes)
        );
        byte[] buffer = new byte[chunkBytes];
        recorder.startRecording();
        try {
            while (running) {
                int read = recorder.read(buffer, 0, buffer.length);
                if (read <= 0) continue;
                if (rms(buffer, read) < 0.012) continue;
                byte[] copy = new byte[read];
                System.arraycopy(buffer, 0, copy, 0, read);
                jobs.execute(() -> transcribeChunk(copy));
            }
        } finally {
            try {
                recorder.stop();
            } catch (Exception ignored) {
                /* already stopped */
            }
            recorder.release();
        }
    }

    private void transcribeChunk(byte[] pcm) {
        try {
            byte[] wav = WavWriter.pcm16ToWav(pcm, SAMPLE_RATE, 1);
            String text = WhisperApi.transcribeWav(wav, "chunk.wav");
            if (text.isEmpty() || looksLikeJunk(text)) return;
            CaptionBus.get().setPartial(text, "");
            String pt = "";
            if (Prefs.translatePt()) {
                try {
                    pt = TranslateApi.translate(text);
                } catch (Exception error) {
                    CaptionBus.get().status(error.getMessage());
                }
            }
            CaptionBus.get().pushFinal(text, pt);
            CaptionBus.get().status("Ao vivo · " + Prefs.provider());
        } catch (Exception error) {
            CaptionBus.get().status(error.getMessage());
        }
    }

    private static boolean looksLikeJunk(String text) {
        String value = text.toLowerCase();
        return value.length() < 2 || value.contains("thanks for watching") || value.contains("subtitle");
    }

    private static double rms(byte[] pcm, int length) {
        if (length < 2) return 0;
        double sum = 0;
        int samples = length / 2;
        for (int i = 0; i + 1 < length; i += 2) {
            int sample = (pcm[i] & 0xff) | (pcm[i + 1] << 8);
            if (sample > 32767) sample -= 65536;
            double norm = sample / 32768.0;
            sum += norm * norm;
        }
        return Math.sqrt(sum / samples);
    }

    private Notification notification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(new NotificationChannel(
                    CHANNEL, "Daily Overlay", NotificationManager.IMPORTANCE_LOW));
        }
        return new NotificationCompat.Builder(this, CHANNEL)
                .setContentTitle(getString(R.string.notif_title))
                .setContentText(getString(R.string.notif_text))
                .setSmallIcon(R.drawable.ic_launcher)
                .setOngoing(true)
                .build();
    }
}
