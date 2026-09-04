package com.dailyoverlay.app;

import android.content.Context;
import android.content.SharedPreferences;

public final class Prefs {
    private static SharedPreferences prefs;

    private Prefs() {}

    public static void init(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences("daily_overlay", Context.MODE_PRIVATE);
    }

    public static String language() {
        return prefs.getString("language", "en-US");
    }

    public static void setLanguage(String value) {
        prefs.edit().putString("language", value).apply();
    }

    public static String provider() {
        return prefs.getString("provider", "openai");
    }

    public static void setProvider(String value) {
        prefs.edit().putString("provider", value).apply();
    }

    public static String apiKey() {
        return prefs.getString("apiKey", "");
    }

    public static void setApiKey(String value) {
        prefs.edit().putString("apiKey", value).apply();
    }

    public static boolean translatePt() {
        return prefs.getBoolean("translatePt", true);
    }

    public static void setTranslatePt(boolean value) {
        prefs.edit().putBoolean("translatePt", value).apply();
    }

    public static String translateEngine() {
        return prefs.getString("translateEngine", "free");
    }

    public static void setTranslateEngine(String value) {
        prefs.edit().putString("translateEngine", value).apply();
    }

    public static int overlayOpacity() {
        return prefs.getInt("overlayOpacity", 35);
    }

    public static void setOverlayOpacity(int value) {
        prefs.edit().putInt("overlayOpacity", value).apply();
    }

    public static String youtubeUrl() {
        return prefs.getString("youtubeUrl", "");
    }

    public static void setYoutubeUrl(String value) {
        prefs.edit().putString("youtubeUrl", value).apply();
    }
}
