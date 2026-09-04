package com.dailyoverlay.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

public final class WhisperApi {
    public static final class Segment {
        public final double start;
        public final double end;
        public final String text;

        public Segment(double start, double end, String text) {
            this.start = start;
            this.end = end;
            this.text = text;
        }
    }

    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .writeTimeout(120, TimeUnit.SECONDS)
            .build();

    private WhisperApi() {}

    public static String transcribeWav(byte[] wav, String fileName) throws IOException {
        JSONObject json = post(wav, fileName, "json", false);
        return json.optString("text", "").replaceAll("\\s+", " ").trim();
    }

    public static List<Segment> transcribeVerbose(byte[] audio, String fileName) throws IOException {
        JSONObject json = post(audio, fileName, "verbose_json", true);
        List<Segment> segments = new ArrayList<>();
        JSONArray array = json.optJSONArray("segments");
        if (array == null) {
            String text = json.optString("text", "").trim();
            if (!text.isEmpty()) segments.add(new Segment(0, 2, text));
            return segments;
        }
        for (int i = 0; i < array.length(); i += 1) {
            JSONObject item = array.optJSONObject(i);
            if (item == null) continue;
            String text = item.optString("text", "").replaceAll("\\s+", " ").trim();
            if (text.isEmpty()) continue;
            segments.add(new Segment(item.optDouble("start"), item.optDouble("end"), text));
        }
        return segments;
    }

    private static JSONObject post(byte[] data, String fileName, String format, boolean verbose) throws IOException {
        String provider = Prefs.provider();
        String endpoint = "openai".equals(provider)
                ? "https://api.openai.com/v1/audio/transcriptions"
                : "https://api.groq.com/openai/v1/audio/transcriptions";
        String model = "openai".equals(provider) ? "whisper-1" : "whisper-large-v3";
        String language = Prefs.language();
        String lang = language.startsWith("pt") ? "pt" : language.startsWith("es") ? "es" : "en";

        MultipartBody.Builder body = new MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("file", fileName,
                        RequestBody.create(data, MediaType.parse(fileName.endsWith(".mp3") ? "audio/mpeg" : "audio/wav")))
                .addFormDataPart("model", model)
                .addFormDataPart("language", lang)
                .addFormDataPart("response_format", format);
        if (verbose) {
            body.addFormDataPart("timestamp_granularities[]", "segment");
        }

        Request request = new Request.Builder()
                .url(endpoint)
                .addHeader("Authorization", "Bearer " + Prefs.apiKey())
                .post(body.build())
                .build();
        try (Response response = CLIENT.newCall(request).execute()) {
            String raw = response.body() == null ? "" : response.body().string();
            if (!response.isSuccessful()) {
                throw new IOException("Whisper falhou (" + response.code() + "): " + raw.substring(0, Math.min(180, raw.length())));
            }
            try {
                return new JSONObject(raw);
            } catch (Exception error) {
                throw new IOException("Resposta inválida do Whisper");
            }
        }
    }
}
