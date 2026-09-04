package com.dailyoverlay.app;

import android.Manifest;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.SeekBar;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends AppCompatActivity implements CaptionBus.Listener {
    private static final int REQ_PERMS = 21;
    private final ExecutorService youtubeJobs = Executors.newSingleThreadExecutor();
    private Button btnToggle;
    private Button btnYoutube;
    private TextView txtStatus;
    private TextView txtTranscript;
    private TextView txtYoutube;
    private EditText edtApiKey;
    private EditText edtYoutube;
    private Spinner spinLanguage;
    private Spinner spinProvider;
    private Spinner spinTranslateEngine;
    private CheckBox chkTranslate;
    private SeekBar seekOpacity;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        btnToggle = findViewById(R.id.btnToggle);
        btnYoutube = findViewById(R.id.btnYoutube);
        txtStatus = findViewById(R.id.txtStatus);
        txtTranscript = findViewById(R.id.txtTranscript);
        txtYoutube = findViewById(R.id.txtYoutube);
        edtApiKey = findViewById(R.id.edtApiKey);
        edtYoutube = findViewById(R.id.edtYoutube);
        spinLanguage = findViewById(R.id.spinLanguage);
        spinProvider = findViewById(R.id.spinProvider);
        spinTranslateEngine = findViewById(R.id.spinTranslateEngine);
        chkTranslate = findViewById(R.id.chkTranslate);
        seekOpacity = findViewById(R.id.seekOpacity);

        bindSpinner(spinLanguage, R.array.languages, R.array.language_values, Prefs.language(), Prefs::setLanguage);
        bindSpinner(spinProvider, R.array.providers, R.array.provider_values, Prefs.provider(), Prefs::setProvider);
        bindSpinner(spinTranslateEngine, R.array.translate_engines, R.array.translate_engine_values, Prefs.translateEngine(), Prefs::setTranslateEngine);

        edtApiKey.setText(Prefs.apiKey());
        edtApiKey.setOnFocusChangeListener((v, hasFocus) -> {
            if (!hasFocus) Prefs.setApiKey(edtApiKey.getText().toString().trim());
        });
        edtYoutube.setText(Prefs.youtubeUrl());
        chkTranslate.setChecked(Prefs.translatePt());
        chkTranslate.setOnCheckedChangeListener((v, checked) -> Prefs.setTranslatePt(checked));
        seekOpacity.setProgress(Prefs.overlayOpacity());
        seekOpacity.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                Prefs.setOverlayOpacity(progress);
                if (CaptionBus.get().overlay() != null) CaptionBus.get().overlay().applyOpacity();
            }
            @Override public void onStartTrackingTouch(SeekBar seekBar) {}
            @Override public void onStopTrackingTouch(SeekBar seekBar) {}
        });

        btnToggle.setOnClickListener(v -> toggle());
        btnYoutube.setOnClickListener(v -> runYoutube());
        findViewById(R.id.btnCopy).setOnClickListener(v -> copyAta());
        findViewById(R.id.btnClear).setOnClickListener(v -> CaptionBus.get().clear());
        CaptionBus.get().addListener(this);
        renderToggle(CaptionBus.get().snapshot());
    }

    @Override
    protected void onDestroy() {
        CaptionBus.get().removeListener(this);
        youtubeJobs.shutdownNow();
        super.onDestroy();
    }

    @Override
    public void onCaption(CaptionBus.Snapshot snapshot) {
        renderToggle(snapshot);
        String ata = snapshot.ata();
        if (!snapshot.partial.isEmpty()) {
            ata = (ata.isEmpty() ? "" : ata + "\n\n") + snapshot.partial
                    + (snapshot.translation.isEmpty() ? "" : "\n→ " + snapshot.translation);
        }
        txtTranscript.setText(ata);
    }

    @Override
    public void onStatus(String message) {
        txtStatus.setText(message);
    }

    private void toggle() {
        Prefs.setApiKey(edtApiKey.getText().toString().trim());
        if (CaptionBus.get().snapshot().running) {
            stopService(new Intent(this, CaptionService.class).setAction(CaptionService.ACTION_STOP));
            return;
        }
        if (Prefs.apiKey().isEmpty()) {
            txtStatus.setText("Cola a API key do Whisper");
            return;
        }
        if (!hasAudioPermission()) {
            requestPermissions();
            return;
        }
        if (CaptionBus.get().overlay() != null && !CaptionBus.get().overlay().canDraw()) {
            Toast.makeText(this, "Libera a permissão de overlay (exibir sobre outros apps)", Toast.LENGTH_LONG).show();
            startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + getPackageName())));
            return;
        }
        Intent intent = new Intent(this, CaptionService.class).setAction(CaptionService.ACTION_START);
        ContextCompat.startForegroundService(this, intent);
    }

    private void runYoutube() {
        Prefs.setApiKey(edtApiKey.getText().toString().trim());
        String url = edtYoutube.getText().toString().trim();
        Prefs.setYoutubeUrl(url);
        if (url.isEmpty()) {
            txtYoutube.setText("Cola o link do YouTube");
            return;
        }
        if (Prefs.apiKey().isEmpty()) {
            txtYoutube.setText("Cola a API key do Whisper");
            return;
        }
        btnYoutube.setEnabled(false);
        txtYoutube.setText("Trabalhando…");
        youtubeJobs.execute(() -> {
            try {
                YoutubeJob.Result result = YoutubeJob.run(this, url, message -> runOnUiThread(() -> {
                    txtYoutube.setText(message);
                    txtStatus.setText(message);
                }));
                runOnUiThread(() -> {
                    CaptionBus.get().clear();
                    for (int i = 0; i < result.lines.size(); i += 1) {
                        String pt = i < result.linesPt.size() ? result.linesPt.get(i) : "";
                        CaptionBus.get().pushFinal(result.lines.get(i), pt);
                    }
                    txtYoutube.setText("SRT salvo em " + result.savedPath);
                    txtStatus.setText("YouTube pronto");
                    btnYoutube.setEnabled(true);
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    txtYoutube.setText(error.getMessage());
                    txtStatus.setText(error.getMessage());
                    btnYoutube.setEnabled(true);
                });
            }
        });
    }

    private void copyAta() {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        clipboard.setPrimaryClip(ClipData.newPlainText("ata", CaptionBus.get().snapshot().ata()));
        Toast.makeText(this, "Ata copiada", Toast.LENGTH_SHORT).show();
    }

    private void renderToggle(CaptionBus.Snapshot snapshot) {
        if (snapshot.running) {
            btnToggle.setText(R.string.stop);
            btnToggle.setBackgroundResource(R.drawable.bg_button_live);
            btnToggle.setTextColor(0xFFFFFFFF);
        } else {
            btnToggle.setText(R.string.start);
            btnToggle.setBackgroundResource(R.drawable.bg_button);
            btnToggle.setTextColor(0xFF1B140B);
        }
    }

    private boolean hasAudioPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void requestPermissions() {
        java.util.ArrayList<String> perms = new java.util.ArrayList<>();
        perms.add(Manifest.permission.RECORD_AUDIO);
        if (Build.VERSION.SDK_INT >= 33) perms.add(Manifest.permission.POST_NOTIFICATIONS);
        ActivityCompat.requestPermissions(this, perms.toArray(new String[0]), REQ_PERMS);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_PERMS && hasAudioPermission()) toggle();
    }

    private void bindSpinner(Spinner spinner, int labels, int valuesId, String current, Setter setter) {
        ArrayAdapter<CharSequence> adapter = ArrayAdapter.createFromResource(this, labels, android.R.layout.simple_spinner_dropdown_item);
        spinner.setAdapter(adapter);
        String[] values = getResources().getStringArray(valuesId);
        for (int i = 0; i < values.length; i += 1) {
            if (values[i].equals(current)) spinner.setSelection(i);
        }
        spinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                setter.set(values[position]);
            }
            @Override public void onNothingSelected(AdapterView<?> parent) {}
        });
    }

    private interface Setter {
        void set(String value);
    }
}
