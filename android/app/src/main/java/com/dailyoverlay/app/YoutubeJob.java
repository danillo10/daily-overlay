package com.dailyoverlay.app;

import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

public final class YoutubeJob {
    public interface Progress {
        void onProgress(String message);
    }

    public static final class Result {
        public final String title;
        public final String ata;
        public final List<String> lines = new ArrayList<>();
        public final List<String> linesPt = new ArrayList<>();
        public String savedPath = "";

        Result(String title, String ata) {
            this.title = title;
            this.ata = ata;
        }
    }

    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
            .followRedirects(true)
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .build();

    private static final String[] PIPED = {
            "https://pipedapi.kavin.rocks",
            "https://pipedapi.adminforge.de",
            "https://api.piped.private.coffee"
    };

    private YoutubeJob() {}

    public static Result run(Context context, String url, Progress progress) throws Exception {
        String id = videoId(url);
        if (id == null) throw new IllegalArgumentException("Cola um link do YouTube.");
        if (Prefs.apiKey().trim().isEmpty()) throw new IllegalStateException("Cola a API key do Whisper.");

        progress.onProgress("Lendo o vídeo…");
        JSONObject info = fetchInfo(id);
        String title = info.optString("title", id);
        String audioUrl = pickAudio(info);
        if (audioUrl.isEmpty()) throw new IllegalStateException("Não achei o áudio desse vídeo.");

        progress.onProgress("Baixando o áudio…");
        byte[] audio = download(audioUrl);
        if (audio.length > 24 * 1024 * 1024) {
            throw new IllegalStateException("Áudio grande demais para o Whisper (máx. 25 MB). Usa um vídeo mais curto.");
        }

        progress.onProgress("Transcrevendo com Whisper…");
        List<WhisperApi.Segment> segments = WhisperApi.transcribeVerbose(audio, "audio.mp3");
        if (segments.isEmpty()) throw new IllegalStateException("O Whisper não achou fala nesse vídeo.");

        Result result = new Result(title, "");
        StringBuilder srt = new StringBuilder();
        StringBuilder ata = new StringBuilder();
        for (int i = 0; i < segments.size(); i += 1) {
            WhisperApi.Segment segment = segments.get(i);
            progress.onProgress("Traduzindo " + (i + 1) + "/" + segments.size() + "…");
            String pt = segment.text;
            try {
                if (Prefs.translatePt()) pt = TranslateApi.translate(segment.text);
            } catch (Exception ignored) {
                pt = segment.text;
            }
            result.lines.add(segment.text);
            result.linesPt.add(pt);
            if (ata.length() > 0) ata.append("\n\n");
            ata.append(segment.text).append("\n→ ").append(pt);
            srt.append(i + 1).append('\n')
                    .append(srtTime(segment.start)).append(" --> ").append(srtTime(segment.end)).append('\n')
                    .append(pt).append('\n')
                    .append(segment.text).append("\n\n");
        }
        progress.onProgress("Salvando o SRT…");
        result.savedPath = saveSrt(context, title, srt.toString());
        return new Result(title, ata.toString()) {
            {
                lines.addAll(result.lines);
                linesPt.addAll(result.linesPt);
                savedPath = result.savedPath;
            }
        };
    }

    private static JSONObject fetchInfo(String id) throws Exception {
        Exception last = new Exception("Nenhuma API do YouTube respondeu.");
        for (String host : PIPED) {
            Request request = new Request.Builder().url(host + "/streams/" + id).get().build();
            try (Response response = CLIENT.newCall(request).execute()) {
                if (!response.isSuccessful() || response.body() == null) continue;
                return new JSONObject(response.body().string());
            } catch (Exception error) {
                last = error;
            }
        }
        throw last;
    }

    private static String pickAudio(JSONObject info) {
        JSONArray streams = info.optJSONArray("audioStreams");
        if (streams == null) return "";
        String best = "";
        int bestBitrate = -1;
        for (int i = 0; i < streams.length(); i += 1) {
            JSONObject item = streams.optJSONObject(i);
            if (item == null) continue;
            String mime = item.optString("mimeType", "");
            int bitrate = item.optInt("bitrate", 0);
            if ((mime.contains("mp4") || mime.contains("mpeg") || mime.contains("webm")) && bitrate > bestBitrate) {
                bestBitrate = bitrate;
                best = item.optString("url", "");
            }
        }
        return best;
    }

    private static byte[] download(String url) throws Exception {
        Request request = new Request.Builder().url(url).get().build();
        try (Response response = CLIENT.newCall(request).execute()) {
            if (!response.isSuccessful() || response.body() == null) {
                throw new IllegalStateException("Falha ao baixar o áudio (" + response.code() + ")");
            }
            InputStream in = response.body().byteStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    private static String videoId(String url) {
        if (url == null) return null;
        Matcher matcher = Pattern.compile("(?:v=|youtu\\.be/|shorts/)([A-Za-z0-9_-]{11})").matcher(url);
        return matcher.find() ? matcher.group(1) : null;
    }

    private static String srtTime(double seconds) {
        int total = (int) Math.max(0, Math.round(seconds * 1000));
        int ms = total % 1000;
        int s = (total / 1000) % 60;
        int m = (total / 60000) % 60;
        int h = total / 3600000;
        return String.format(Locale.US, "%02d:%02d:%02d,%03d", h, m, s, ms);
    }

    private static String saveSrt(Context context, String title, String content) throws Exception {
        String name = title.replaceAll("[\\\\/:*?\"<>|]+", " ").trim();
        if (name.isEmpty()) name = "youtube";
        name = name + ".srt";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, "application/x-subrip");
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Daily Overlay");
            Uri uri = context.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IllegalStateException("Não consegui salvar o SRT.");
            try (OutputStream out = context.getContentResolver().openOutputStream(uri)) {
                if (out == null) throw new IllegalStateException("Não consegui escrever o SRT.");
                out.write(content.getBytes(StandardCharsets.UTF_8));
            }
            return "Downloads/Daily Overlay/" + name;
        }
        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Daily Overlay");
        if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("Não consegui criar a pasta.");
        File file = new File(dir, name);
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(content.getBytes(StandardCharsets.UTF_8));
        }
        return file.getAbsolutePath();
    }
}
