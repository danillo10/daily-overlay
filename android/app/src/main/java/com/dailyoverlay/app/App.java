package com.dailyoverlay.app;

import android.app.Application;

public class App extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        Prefs.init(this);
        CaptionBus.get().attach(this);
    }
}
