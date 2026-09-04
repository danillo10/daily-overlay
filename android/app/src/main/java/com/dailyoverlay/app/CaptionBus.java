package com.dailyoverlay.app;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

public final class CaptionBus {
    public interface Listener {
        void onCaption(Snapshot snapshot);
        void onStatus(String message);
    }

    public static final class Snapshot {
        public final boolean running;
        public final String partial;
        public final String translation;
        public final List<String> lines;
        public final List<String> linesPt;

        Snapshot(boolean running, String partial, String translation, List<String> lines, List<String> linesPt) {
            this.running = running;
            this.partial = partial == null ? "" : partial;
            this.translation = translation == null ? "" : translation;
            this.lines = lines;
            this.linesPt = linesPt;
        }

        public String ata() {
            StringBuilder builder = new StringBuilder();
            for (int i = 0; i < lines.size(); i += 1) {
                if (builder.length() > 0) builder.append("\n\n");
                builder.append(lines.get(i));
                if (i < linesPt.size() && !linesPt.get(i).isEmpty()) {
                    builder.append("\n→ ").append(linesPt.get(i));
                }
            }
            return builder.toString();
        }
    }

    private static final CaptionBus INSTANCE = new CaptionBus();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<Listener> listeners = new CopyOnWriteArrayList<>();
    private final List<String> lines = new ArrayList<>();
    private final List<String> linesPt = new ArrayList<>();
    private String partial = "";
    private String translation = "";
    private boolean running;
    private OverlayController overlay;

    public static CaptionBus get() {
        return INSTANCE;
    }

    void attach(Context context) {
        if (overlay == null) overlay = new OverlayController(context.getApplicationContext());
    }

    public void addListener(Listener listener) {
        listeners.add(listener);
        listener.onCaption(snapshot());
    }

    public void removeListener(Listener listener) {
        listeners.remove(listener);
    }

    public synchronized void setRunning(boolean value) {
        running = value;
        if (!value) {
            partial = "";
            translation = "";
            if (overlay != null) overlay.hide();
        }
        emit();
    }

    public synchronized void setPartial(String text, String pt) {
        partial = text == null ? "" : text;
        translation = pt == null ? "" : pt;
        emit();
    }

    public synchronized void pushFinal(String text, String pt) {
        String clean = text == null ? "" : text.trim();
        if (clean.isEmpty()) return;
        if (!lines.isEmpty() && lines.get(lines.size() - 1).equals(clean)) {
            if (pt != null && !pt.isEmpty()) linesPt.set(linesPt.size() - 1, pt);
        } else {
            lines.add(clean);
            linesPt.add(pt == null ? "" : pt);
        }
        partial = "";
        translation = pt == null ? "" : pt;
        emit();
    }

    public synchronized void clear() {
        lines.clear();
        linesPt.clear();
        partial = "";
        translation = "";
        emit();
    }

    public synchronized Snapshot snapshot() {
        return new Snapshot(running, partial, translation, new ArrayList<>(lines), new ArrayList<>(linesPt));
    }

    public void status(String message) {
        main.post(() -> {
            for (Listener listener : listeners) listener.onStatus(message);
        });
    }

    public OverlayController overlay() {
        return overlay;
    }

    private void emit() {
        Snapshot snap = snapshot();
        main.post(() -> {
            for (Listener listener : listeners) listener.onCaption(snap);
            if (overlay != null && running) overlay.show(snap);
        });
    }
}
