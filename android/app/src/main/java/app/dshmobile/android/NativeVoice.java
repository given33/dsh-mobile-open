package app.dshmobile.android;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.view.MotionEvent;
import android.webkit.WebView;
import java.util.ArrayList;
import java.util.Locale;
import org.json.JSONObject;

final class NativeVoice {
    static final int PERMISSION = 408;
    private final MainActivity activity;
    private SpeechRecognizer recognizer;
    private String id, permissionID, partial = "";
    private long downAt, lastLevel;
    private float x, y;
    private boolean ending, autoLanguages;
    private final Runnable limit = this::stop;
    private final Runnable settle = () -> finish(partial);

    NativeVoice(MainActivity activity) { this.activity = activity; }

    void observeTouch(MotionEvent event) {
        if (event.getActionMasked() == MotionEvent.ACTION_DOWN) {
            downAt = SystemClock.uptimeMillis(); x = event.getX(); y = event.getY();
        }
    }

    void message(WebView view, JSONObject data) {
        String next = data.optString("id");
        if (!next.startsWith("dml-") || next.length() >= 64) return;
        switch (data.optString("type")) {
            case "voice-cancel": if (next.equals(id)) cancel(); return;
            case "voice-stop": if (next.equals(id)) stop(); return;
            case "voice-start": break;
            default: return;
        }
        double w = data.optDouble("width");
        double scale = view.getWidth() / w;
        if (id != null || !activity.foreground || !activity.routeApplied || !(w > 0) ||
                SystemClock.uptimeMillis() - downAt >= 1200 ||
                !(Math.hypot(x - data.optDouble("x") * scale, y - data.optDouble("y") * scale) < activity.dp(44))) return;
        downAt = 0;
        if (Build.VERSION.SDK_INT < 31 || !SpeechRecognizer.isOnDeviceRecognitionAvailable(activity)) {
            emit(next, "error", "此设备没有可用的设备端语音识别，请使用系统键盘听写。", null); return;
        }
        if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            if (permissionID != null) return;
            permissionID = next;
            activity.requestPermissions(new String[]{ Manifest.permission.RECORD_AUDIO }, PERMISSION);
            return;
        }
        id = next; partial = ""; ending = false;
        autoLanguages = Build.VERSION.SDK_INT >= 34;
        listen(next);
    }

    void permissionResult(boolean granted) {
        String pending = permissionID; permissionID = null;
        if (pending != null) emit(pending, granted ? "permission-ready" : "error",
            granted ? "已授权，请重新按住麦克风说话" : "请在系统设置中允许 DSH Mobile 使用麦克风。", null);
    }

    private void listen(String token) {
        try {
            final SpeechRecognizer engine = SpeechRecognizer.createOnDeviceSpeechRecognizer(activity);
            recognizer = engine;
            engine.setRecognitionListener(new RecognitionListener() {
                private boolean live() { return engine == recognizer && token.equals(id); }
                @Override public void onReadyForSpeech(Bundle ignored) { if (live()) emit(token, "recording", null, null); }
                @Override public void onBeginningOfSpeech() {}
                @Override public void onRmsChanged(float rms) {
                    long now = SystemClock.uptimeMillis();
                    if (!live() || ending || now - lastLevel < 95) return;
                    lastLevel = now;
                    emit(token, "level", null, (double) Math.max(0, Math.min(1, (rms + 2) / 13)));
                }
                @Override public void onBufferReceived(byte[] ignored) {}
                @Override public void onEndOfSpeech() {}
                @Override public void onError(int code) {
                    if (!live()) return;
                    if (autoLanguages && !ending && (code == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED || code == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE)) {
                        autoLanguages = false; engine.destroy(); recognizer = null; listen(token); return;
                    }
                    if (!partial.isEmpty() || ending || code == SpeechRecognizer.ERROR_NO_MATCH || code == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) finish(partial);
                    else { cancel(); emit(token, "error", "设备端语音识别暂不可用，请确认系统已下载当前语言，或使用键盘听写。", null); }
                }
                @Override public void onResults(Bundle results) { if (live()) finish(best(results, partial)); }
                @Override public void onPartialResults(Bundle results) { if (live()) partial = best(results, partial); }
                @Override public void onEvent(int type, Bundle params) {}
            });
            Intent request = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
            if (Build.VERSION.SDK_INT >= 34 && autoLanguages) {
                request.putExtra(RecognizerIntent.EXTRA_ENABLE_LANGUAGE_DETECTION, true);
                request.putExtra(RecognizerIntent.EXTRA_ENABLE_LANGUAGE_SWITCH, RecognizerIntent.LANGUAGE_SWITCH_BALANCED);
            }
            engine.startListening(request);
            activity.ui.removeCallbacks(limit);
            activity.ui.postDelayed(limit, 55_000);
        } catch (RuntimeException error) {
            cancel(); emit(token, "error", "无法启动设备端识别，请检查系统语音服务。", null);
        }
    }

    private static String best(Bundle bundle, String fallback) {
        ArrayList<String> words = bundle == null ? null : bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return words == null || words.isEmpty() || words.get(0).trim().isEmpty() ? fallback : words.get(0);
    }

    private void stop() {
        if (recognizer == null || ending) return;
        ending = true;
        try { recognizer.stopListening(); } catch (RuntimeException error) { finish(partial); return; }
        activity.ui.postDelayed(settle, 1800);
    }

    private void finish(String words) {
        if (id == null) return;
        String token = id; cancel(); emit(token, "final", words, null);
    }

    void cancel() {
        id = null; downAt = 0;
        activity.ui.removeCallbacks(limit); activity.ui.removeCallbacks(settle);
        if (recognizer != null) { SpeechRecognizer old = recognizer; recognizer = null; old.destroy(); }
    }

    private void emit(String token, String status, String message, Double level) {
        try {
            JSONObject data = new JSONObject().put("id", token).put("status", status);
            if (message != null) data.put(status.equals("final") ? "text" : "message", message);
            if (level != null) data.put("level", level);
            activity.js("window.__DSH_MOBILE_BRIDGE__?.voiceEvent?.(" + data + ")");
        } catch (org.json.JSONException ignored) { /* Non-finite volume can be omitted. */ }
    }
}
