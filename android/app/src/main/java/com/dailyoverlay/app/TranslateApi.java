package com.dailyoverlay.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

public final class TranslateApi {
    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(40, TimeUnit.SECONDS)
            .build();

    private TranslateApi() {}

    public static String translate(String text) throws IOException {
        String source = text == null ? "" : text.replaceAll("\\s+", " ").trim();
        if (source.isEmpty()) return "";
        if (!Prefs.translatePt()) return "";
        if ("cloud".equals(Prefs.translateEngine())) return translateCloud(source);
        return translateFree(source);
    }

    private static String langPair() {
        String language = Prefs.language();
        if (language.startsWith("pt")) return "pt|pt-BR";
        if (language.startsWith("es")) return "es|pt-BR";
        return "en|pt-BR";
    }

    private static String translateFree(String source) throws IOException {
        if (Prefs.language().startsWith("pt")) return source;
        String url = "https://api.mymemory.translated.net/get?q="
                + URLEncoder.encode(source.substring(0, Math.min(480, source.length())), StandardCharsets.UTF_8.name())
                + "&langpair=" + langPair();
        Request request = new Request.Builder().url(url).get().build();
        try (Response response = CLIENT.newCall(request).execute()) {
            String raw = response.body() == null ? "" : response.body().string();
            if (!response.isSuccessful()) throw new IOException("Tradução grátis falhou (" + response.code() + ")");
            try {
                String translated = new JSONObject(raw).optJSONObject("responseData").optString("translatedText", "");
                return translated.replaceFirst("(?i)^MYMEMORY WARNING:[^.]*[. ]*", "").replaceAll("\\s+", " ").trim();
            } catch (Exception error) {
                throw new IOException("Tradução grátis sem resultado");
            }
        }
    }

    private static String translateCloud(String source) throws IOException {
        boolean openAi = "openai".equals(Prefs.provider()) || Prefs.apiKey().startsWith("sk-");
        String endpoint = openAi
                ? "https://api.openai.com/v1/chat/completions"
                : "https://api.groq.com/openai/v1/chat/completions";
        String[] models = openAi ? new String[]{"gpt-4.1-nano", "gpt-4o-mini"} : new String[]{"llama-3.1-8b-instant"};
        IOException last = null;
        for (String model : models) {
            try {
                JSONObject body = new JSONObject();
                body.put("model", model);
                body.put("temperature", 0);
                body.put("max_tokens", 180);
                JSONArray messages = new JSONArray();
                messages.put(new JSONObject()
                        .put("role", "system")
                        .put("content", "Traduza para português brasileiro. Responda só com a tradução, sem aspas e sem explicação."));
                messages.put(new JSONObject().put("role", "user").put("content", source));
                body.put("messages", messages);
                Request request = new Request.Builder()
                        .url(endpoint)
                        .addHeader("Authorization", "Bearer " + Prefs.apiKey())
                        .addHeader("Content-Type", "application/json")
                        .post(RequestBody.create(body.toString(), MediaType.parse("application/json")))
                        .build();
                try (Response response = CLIENT.newCall(request).execute()) {
                    String raw = response.body() == null ? "" : response.body().string();
                    if (response.code() == 404) continue;
                    if (!response.isSuccessful()) throw new IOException("Falha ao traduzir (" + response.code() + ")");
                    return new JSONObject(raw)
                            .getJSONArray("choices")
                            .getJSONObject(0)
                            .getJSONObject("message")
                            .optString("content", "")
                            .replaceAll("\\s+", " ")
                            .trim();
                }
            } catch (Exception error) {
                last = error instanceof IOException ? (IOException) error : new IOException(error.getMessage());
            }
        }
        if (last != null) throw last;
        return "";
    }
}
