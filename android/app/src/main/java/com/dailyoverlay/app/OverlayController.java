package com.dailyoverlay.app;

import android.content.Context;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.provider.Settings;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

public final class OverlayController {
    private final Context context;
    private final WindowManager windowManager;
    private View root;
    private WindowManager.LayoutParams params;
    private TextView enView;
    private TextView ptView;
    private LinearLayout box;
    private float downX;
    private float downY;
    private int startX;
    private int startY;

    OverlayController(Context context) {
        this.context = context;
        this.windowManager = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
    }

    public boolean canDraw() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context);
    }

    public void show(CaptionBus.Snapshot snapshot) {
        if (!canDraw()) return;
        if (root == null) attach();
        String en = !snapshot.partial.isEmpty() ? snapshot.partial
                : (snapshot.lines.isEmpty() ? "" : snapshot.lines.get(snapshot.lines.size() - 1));
        String pt = snapshot.translation;
        if (pt.isEmpty() && !snapshot.linesPt.isEmpty()) {
            pt = snapshot.linesPt.get(snapshot.linesPt.size() - 1);
        }
        if (!Prefs.translatePt()) pt = "";
        enView.setText(en);
        ptView.setText(pt);
        ptView.setVisibility(pt.isEmpty() ? View.GONE : View.VISIBLE);
        applyOpacity();
        if (root.getWindowToken() == null) {
            try {
                windowManager.addView(root, params);
            } catch (Exception ignored) {
                /* already attached */
            }
        }
    }

    public void hide() {
        if (root != null && root.getWindowToken() != null) {
            try {
                windowManager.removeView(root);
            } catch (Exception ignored) {
                /* gone */
            }
        }
    }

    public void applyOpacity() {
        if (box == null) return;
        int alpha = Math.max(0, Math.min(230, (int) (Prefs.overlayOpacity() / 90f * 230)));
        GradientDrawable background = new GradientDrawable();
        background.setCornerRadius(28);
        background.setColor(Color.argb(alpha, 8, 10, 14));
        box.setBackground(background);
    }

    private void attach() {
        root = LayoutInflater.from(context).inflate(R.layout.overlay_caption, null);
        box = root.findViewById(R.id.overlayRoot);
        enView = root.findViewById(R.id.overlayEn);
        ptView = root.findViewById(R.id.overlayPt);
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
        params = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT
        );
        params.gravity = Gravity.TOP | Gravity.START;
        params.y = 220;
        params.x = 16;
        root.setOnTouchListener((view, event) -> {
            if (event.getAction() == MotionEvent.ACTION_DOWN) {
                downX = event.getRawX();
                downY = event.getRawY();
                startX = params.x;
                startY = params.y;
                return true;
            }
            if (event.getAction() == MotionEvent.ACTION_MOVE) {
                params.gravity = Gravity.TOP | Gravity.START;
                params.x = startX + Math.round(event.getRawX() - downX);
                params.y = startY + Math.round(event.getRawY() - downY);
                if (root.getWindowToken() != null) windowManager.updateViewLayout(root, params);
                return true;
            }
            return false;
        });
    }
}
